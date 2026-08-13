import { CashCountMode } from '@jingles/shared';

const mockTx = {
  syncDeviceState: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  syncEvent: {
    count: jest.fn(),
  },
  syncConflict: {
    count: jest.fn(),
  },
  configEntry: {
    findUnique: jest.fn(),
  },
  pOSShift: {
    findUnique: jest.fn(),
  },
};

jest.mock('../prisma', () => ({
  __esModule: true,
  default: {
    $transaction: async (callback: (tx: typeof mockTx) => unknown) => callback(mockTx),
    syncDeviceState: mockTx.syncDeviceState,
    syncEvent: mockTx.syncEvent,
    syncConflict: mockTx.syncConflict,
    configEntry: mockTx.configEntry,
    pOSShift: mockTx.pOSShift,
  },
}));

const { buildDrawerContents, buildZReport, confirmPlayback, getLocalSyncStatus, getServerVectorClock } = require('../services/posSync') as typeof import('../services/posSync');
const { authenticate, resolveUnlockMode } = require('../routes/auth') as typeof import('../routes/auth');
const { buildFtsQuery } = require('../services/localCatalog') as typeof import('../services/localCatalog');
const originalPosSyncAppToken = process.env.JINGLES_POS_SYNC_APP_TOKEN;
const originalLegacyPosSyncAppToken = process.env.POS_SYNC_APP_TOKEN;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JINGLES_POS_SYNC_APP_TOKEN = '';
  process.env.POS_SYNC_APP_TOKEN = '';
});

afterAll(() => {
  process.env.JINGLES_POS_SYNC_APP_TOKEN = originalPosSyncAppToken;
  process.env.POS_SYNC_APP_TOKEN = originalLegacyPosSyncAppToken;
});

describe('event sourced POS backend services', () => {
  it('uses a reversed PIN to enter no-cash mode', () => {
    expect(resolveUnlockMode('1042', '1042')).toBe('normal');
    expect(resolveUnlockMode('1042', '2401')).toBe('no-cash');
    expect(resolveUnlockMode('1042', '9999')).toBeNull();
  });

  it('rejects POS business requests without a login token', async () => {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const next = jest.fn();

    await authenticate({ headers: {} } as never, { status, json } as never, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Missing authorization token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('builds the server vector clock from device state rows', async () => {
    mockTx.syncDeviceState.findMany.mockResolvedValue([
      { deviceId: 'device-a', lastSequenceNum: 4 },
      { deviceId: 'device-b', lastSequenceNum: 2 },
    ]);

    await expect(getServerVectorClock(mockTx as never)).resolves.toEqual({
      'device-a': 4,
      'device-b': 2,
    });
  });

  it('confirms playback by persisting the remote clock for the device', async () => {
    mockTx.syncDeviceState.findUnique.mockResolvedValue({
      id: 'state-b',
      deviceId: 'device-b',
      terminalId: 'terminal-03',
      lastSequenceNum: 9,
      vectorClock: '{"device-b":9}',
      confirmedVectorClock: '{"device-b":8}',
    });
    mockTx.syncDeviceState.upsert.mockResolvedValue(undefined);
    mockTx.syncDeviceState.findMany.mockResolvedValue([
      { deviceId: 'device-a', lastSequenceNum: 4 },
      { deviceId: 'device-b', lastSequenceNum: 9 },
    ]);

    const confirmedClock = await confirmPlayback({
      deviceId: 'device-b',
      terminalId: 'terminal-03',
      vectorClock: { 'device-a': 4, 'device-b': 9 },
    });

    expect(mockTx.syncDeviceState.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { deviceId: 'device-b' },
      update: expect.objectContaining({
        confirmedVectorClock: JSON.stringify({ 'device-a': 4, 'device-b': 9 }),
      }),
    }));
    expect(confirmedClock).toEqual({ 'device-a': 4, 'device-b': 9 });
  });

  it('builds a Z report with refund totals and payment breakdowns', async () => {
    mockTx.pOSShift.findUnique.mockResolvedValue({
      id: 'shift-1',
      openingFloat: 500,
      cashCounts: [
        { mode: CashCountMode.CLOSING, total: 650, createdAt: new Date('2026-05-21T10:00:00Z') },
      ],
      sales: [
        {
          subtotal: 200,
          discountTotal: 20,
          total: 180,
          payments: [{ method: 'CASH', amount: 180 }],
          returns: [{ totalRefund: 40 }],
          lines: [{ quantity: 2, discountAmount: 20 }],
        },
        {
          subtotal: 100,
          discountTotal: 0,
          total: 100,
          payments: [{ method: 'VISA', amount: 100 }],
          returns: [],
          lines: [{ quantity: 1, discountAmount: 0 }],
        },
      ],
    });

    const report = await buildZReport('shift-1');

    expect(report).toEqual({
      shiftId: 'shift-1',
      grossSales: 300,
      discounts: 20,
      refunds: 40,
      netSales: 240,
      transactionCount: 2,
      paymentBreakdown: {
        CASH: 180,
        VISA: 100,
      },
      expectedDrawer: 640,
      openingFloat: 500,
      cashPaidIn: 0,
      cashPaidOut: 0,
      countedDrawer: 650,
      variance: 10,
      paymentCounts: { CASH: 1, VISA: 1 },
      discountedLineCount: 1,
      productCount: 3,
      cashMovements: [],
    });
  });

  it('reports the non-cash tender declared at close alongside the payment breakdown', async () => {
    mockTx.pOSShift.findUnique.mockResolvedValue({
      id: 'shift-2',
      openingFloat: 0,
      cashCounts: [
        {
          mode: CashCountMode.CLOSING,
          total: 180,
          createdAt: new Date('2026-05-21T10:00:00Z'),
          tenders: JSON.stringify({ VISA: 90, MASTER: '10' }),
          tenderMode: 'category',
        },
      ],
      sales: [
        {
          subtotal: 280,
          discountTotal: 0,
          total: 280,
          payments: [
            { method: 'CASH', amount: 180 },
            { method: 'VISA', amount: 100 },
          ],
          returns: [],
          lines: [{ quantity: 1, discountAmount: 0 }],
        },
      ],
    });

    const report = await buildZReport('shift-2');

    // Numeric strings from a hand-edited settings or sync payload are coerced.
    expect(report.declaredTenders).toEqual({ VISA: 90, MASTER: 10 });
    expect(report.declaredTenderMode).toBe('category');
  });

  it('ignores a malformed declared-tender blob rather than failing the Z report', async () => {
    mockTx.pOSShift.findUnique.mockResolvedValue({
      id: 'shift-3',
      openingFloat: 0,
      cashCounts: [
        {
          mode: CashCountMode.CLOSING,
          total: 100,
          createdAt: new Date('2026-05-21T10:00:00Z'),
          tenders: '{not json',
          tenderMode: 'category',
        },
      ],
      sales: [],
    });

    const report = await buildZReport('shift-3');

    expect(report.declaredTenders).toBeUndefined();
    expect(report.transactionCount).toBe(0);
  });

  it('leaves declared tender unset for a cash-only close recorded before the feature existed', async () => {
    mockTx.pOSShift.findUnique.mockResolvedValue({
      id: 'shift-4',
      openingFloat: 0,
      cashCounts: [
        { mode: CashCountMode.CLOSING, total: 100, createdAt: new Date('2026-05-21T10:00:00Z') },
      ],
      sales: [],
    });

    const report = await buildZReport('shift-4');

    expect(report.declaredTenders).toBeUndefined();
    expect(report.declaredTenderMode).toBeUndefined();
  });

  it('folds mid-shift cash movements into the expected drawer', async () => {
    mockTx.pOSShift.findUnique.mockResolvedValue({
      id: 'shift-5',
      openingFloat: 1_000,
      cashCounts: [
        {
          id: 'm1',
          shiftId: 'shift-5',
          mode: CashCountMode.PAID_IN,
          total: 2_000,
          denominations: '{"1000":2}',
          reason: 'Change reload from the safe',
          createdAt: new Date('2026-05-21T11:00:00Z'),
        },
        {
          id: 'm2',
          shiftId: 'shift-5',
          mode: CashCountMode.PAID_OUT,
          total: 500,
          denominations: '{"500":1}',
          reason: 'Safe drop',
          createdAt: new Date('2026-05-21T13:00:00Z'),
        },
      ],
      sales: [
        {
          subtotal: 3_000,
          discountTotal: 0,
          total: 3_000,
          payments: [{ method: 'CASH', amount: 3_000 }],
          returns: [],
          lines: [{ quantity: 1, discountAmount: 0 }],
        },
      ],
    });

    const report = await buildZReport('shift-5');

    // 1,000 float + 3,000 cash sales + 2,000 in - 500 out. Without the movements
    // the drawer would look 1,500 out at close and trip the discrepancy alert.
    expect(report.expectedDrawer).toBe(5_500);
    expect(report.cashPaidIn).toBe(2_000);
    expect(report.cashPaidOut).toBe(500);
    expect(report.cashMovements.map((movement) => movement.direction)).toEqual(['in', 'out']);
    expect(report.cashMovements[0].reason).toBe('Change reload from the safe');
    expect(report.cashMovements[0].denominations).toEqual({ 1000: 2 });
  });

  it('keeps mid-shift movements out of the counted drawer figure', async () => {
    mockTx.pOSShift.findUnique.mockResolvedValue({
      id: 'shift-6',
      openingFloat: 0,
      cashCounts: [
        {
          id: 'm1',
          shiftId: 'shift-6',
          mode: CashCountMode.PAID_IN,
          total: 2_000,
          denominations: '{"1000":2}',
          createdAt: new Date('2026-05-21T11:00:00Z'),
        },
      ],
      sales: [],
    });

    const report = await buildZReport('shift-6');

    // countedDrawer is what the cashier physically counted at close, and no
    // close has happened yet; a paid-in must not masquerade as one.
    expect(report.countedDrawer).toBeUndefined();
    expect(report.variance).toBeUndefined();
    expect(report.expectedDrawer).toBe(2_000);
  });

  describe('drawer contents', () => {
    it('tracks notes in and out to reconstruct what the drawer holds', async () => {
      mockTx.pOSShift.findUnique.mockResolvedValue({
        id: 'shift-d1',
        cashCounts: [
          { mode: CashCountMode.OPENING, total: 1_100, denominations: '{"1000":1,"50":2}' },
          { mode: CashCountMode.PAID_IN, total: 500, denominations: '{"500":1}' },
          { mode: CashCountMode.PAID_OUT, total: 1_000, denominations: '{"1000":1}' },
        ],
        sales: [{
          payments: [{
            method: 'CASH',
            amount: 450,
            tenderedAmount: 500,
            changeDue: 50,
            metadata: '{"denominations":{"500":1},"changeDenominations":{"50":1}}',
          }],
        }],
      });

      const drawer = await buildDrawerContents('shift-d1');

      // 1000: +1 opening, -1 paid out. 50: +2 opening, -1 as change.
      // 500: +1 paid in, +1 taken from the customer.
      expect(drawer.counts).toEqual({ '500': 2, '50': 1 });
      expect(drawer.total).toBe(1_050);
      expect(drawer.exact).toBe(true);
      expect(drawer.unaccountedIn).toBe(0);
      expect(drawer.unaccountedOut).toBe(0);
    });

    it('reports cash with no recorded breakdown separately rather than guessing at notes', async () => {
      mockTx.pOSShift.findUnique.mockResolvedValue({
        id: 'shift-d2',
        cashCounts: [{ mode: CashCountMode.OPENING, total: 1_000, denominations: '{"1000":1}' }],
        sales: [{
          payments: [{
            method: 'CASH',
            amount: 300,
            tenderedAmount: 500,
            changeDue: 200,
            // The cashier typed an amount instead of tapping the note buttons.
            metadata: null,
          }],
        }],
      });

      const drawer = await buildDrawerContents('shift-d2');

      expect(drawer.counts).toEqual({ '1000': 1 });
      expect(drawer.exact).toBe(false);
      expect(drawer.unaccountedIn).toBe(500);
      expect(drawer.unaccountedOut).toBe(200);
    });

    it('ignores non-cash payments, which never touch the drawer', async () => {
      mockTx.pOSShift.findUnique.mockResolvedValue({
        id: 'shift-d3',
        cashCounts: [{ mode: CashCountMode.OPENING, total: 500, denominations: '{"500":1}' }],
        sales: [{
          payments: [{ method: 'VISA', amount: 5_000, tenderedAmount: 5_000, changeDue: 0, metadata: null }],
        }],
      });

      const drawer = await buildDrawerContents('shift-d3');

      expect(drawer.counts).toEqual({ '500': 1 });
      expect(drawer.exact).toBe(true);
    });

    it('clamps a drifted negative count and marks the drawer inexact', async () => {
      mockTx.pOSShift.findUnique.mockResolvedValue({
        id: 'shift-d4',
        cashCounts: [
          { mode: CashCountMode.OPENING, total: 100, denominations: '{"100":1}' },
          { mode: CashCountMode.PAID_OUT, total: 300, denominations: '{"100":3}' },
        ],
        sales: [],
      });

      const drawer = await buildDrawerContents('shift-d4');

      expect(drawer.counts).toEqual({});
      expect(drawer.exact).toBe(false);
    });
  });

  it('treats the configured POS app token as workstation sync auth', async () => {
    process.env.JINGLES_POS_SYNC_APP_TOKEN = 'shared-pos-token';
    mockTx.syncDeviceState.findUnique.mockResolvedValue({
      deviceId: 'device-term-03',
      terminalId: 'terminal-03',
      lastSequenceNum: 1,
      confirmedVectorClock: '{}',
      online: false,
      lastError: 'Host sync authentication is required. Reconnect host sync.',
      lastSyncAt: null,
    });
    mockTx.syncDeviceState.findMany.mockResolvedValue([
      { deviceId: 'device-term-03', lastSequenceNum: 1 },
    ]);
    mockTx.syncEvent.count.mockResolvedValue(1);
    mockTx.syncConflict.count.mockResolvedValue(0);

    const status = await getLocalSyncStatus('device-term-03', 'terminal-03');

    expect(status).toMatchObject({
      deviceId: 'device-term-03',
      pendingEvents: 1,
      conflictCount: 0,
      syncAuthConfigured: true,
      syncAuthMode: 'app_token',
      needsSyncAuth: false,
      lastError: undefined,
    });
    expect(mockTx.configEntry.findUnique).not.toHaveBeenCalled();
  });

  it('sanitizes dotted local catalog FTS queries', () => {
    expect(buildFtsQuery('1.5 mm')).toBe('1 5 mm*');
    expect(buildFtsQuery('...')).toBe('');
  });
});
