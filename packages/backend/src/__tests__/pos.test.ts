import { CashCountMode, SyncConflictPolicy, SyncEventState, SyncEventType, UserRole } from '@jingles/shared';

const mockTx = {
  syncDeviceState: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  syncEvent: {
    count: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
  },
  syncConflict: {
    count: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  configEntry: {
    findUnique: jest.fn(),
  },
  pOSShift: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  pOSUser: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  customer: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  creditPayment: {
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
    pOSUser: mockTx.pOSUser,
    customer: mockTx.customer,
    creditPayment: mockTx.creditPayment,
  },
}));

const { buildDrawerContents, buildZReport, confirmPlayback, getLocalSyncStatus, getServerVectorClock, playbackEvents } = require('../services/posSync') as typeof import('../services/posSync');
const { authenticate, resolveUnlockMode } = require('../routes/auth') as typeof import('../routes/auth');
const { mergeHandshakeReferenceData, respondWithExistingOpenShift } = require('../routes/pos') as typeof import('../routes/pos');
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

  it('recovers an existing shift for the same cashier instead of opening a duplicate', async () => {
    const shift = {
      id: 'shift-existing',
      terminalId: 'terminal-live',
      branchId: 'branch-live',
      userId: 'cashier-live',
      status: 'OPEN',
      openingFloat: 500,
      closingFloat: null,
      openedAt: new Date('2026-08-12T00:45:19+05:30'),
      closedAt: null,
      notes: null,
    };
    mockTx.pOSShift.findFirst.mockResolvedValue(shift);
    mockTx.pOSUser.findMany.mockResolvedValue([{
      id: 'cashier-live',
      name: 'Live Cashier',
    }]);
    const response = {
      status: jest.fn(),
      json: jest.fn(),
    };
    response.status.mockReturnValue(response);
    response.json.mockReturnValue(response);

    const result = await respondWithExistingOpenShift(
      response as never,
      'terminal-live',
      'cashier-live',
    );

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      id: 'shift-existing',
      terminalId: 'terminal-live',
      cashierId: 'cashier-live',
    }));
    expect(result).toBe(response);
  });

  it('reports a shift conflict when another cashier owns the terminal', async () => {
    mockTx.pOSShift.findFirst.mockResolvedValue({
      id: 'shift-existing',
      terminalId: 'terminal-live',
      userId: 'cashier-other',
      status: 'OPEN',
      openedAt: new Date('2026-08-12T00:45:19+05:30'),
    });
    const response = {
      status: jest.fn(),
      json: jest.fn(),
    };
    response.status.mockReturnValue(response);
    response.json.mockReturnValue(response);

    await respondWithExistingOpenShift(response as never, 'terminal-live', 'cashier-live');

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Terminal terminal-live already has an open shift',
    });
  });

  it('merges the complete workstation staff and customer lists during sync handshake', async () => {
    mockTx.pOSUser.findFirst.mockResolvedValue({ id: 'server-user' });
    mockTx.customer.findFirst.mockResolvedValue(null);

    await mergeHandshakeReferenceData(
      [{ id: 'local-user', code: 'ST-1', email: 'staff@example.com', name: 'Staff One', initials: 'SO', role: UserRole.CASHIER }],
      [{ id: 'customer-1', code: 'C-1', name: 'Customer One', tier: 'Retail', creditLimit: 10_000 }],
    );

    expect(mockTx.pOSUser.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'server-user' },
      data: expect.objectContaining({ code: 'ST-1', name: 'Staff One' }),
    }));
    expect(mockTx.customer.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: 'customer-1', code: 'C-1', creditLimit: 10_000 }),
    }));
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
      declaredTenders: undefined,
      declaredTenderMode: undefined,
      paymentDetails: [],
      customerCreditSales: [],
      customerCollections: [],
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

  it('includes customer credit sales, bill collections, cheques and bank transfers in the Z report', async () => {
    mockTx.pOSShift.findUnique.mockResolvedValue({
      id: 'shift-credit',
      openingFloat: 0,
      cashCounts: [],
      creditPayments: [{
        id: 'collection-1', customerId: 'customer-1', amount: 75, method: 'CASH', note: 'Part payment',
        createdAt: new Date('2026-08-14T10:05:00Z'), customer: { name: 'Acme Stores' },
      }],
      sales: [{
        id: 'sale-1', receiptNumber: 'R-100', customerId: 'customer-1', customer: { name: 'Acme Stores' },
        subtotal: 300, discountTotal: 0, total: 300, returns: [], lines: [],
        payments: [
          { method: 'CREDIT', amount: 100, metadata: null, reference: null, createdAt: new Date('2026-08-14T10:00:00Z') },
          { method: 'CHEQUE', amount: 200, reference: 'CH-9', metadata: JSON.stringify({ bankName: 'People Bank', origin: 'Acme Stores', reason: 'Invoice settlement' }), createdAt: new Date('2026-08-14T10:00:00Z') },
        ],
      }],
    });

    const report = await buildZReport('shift-credit');
    expect(report.customerCreditSales).toEqual([expect.objectContaining({ customerName: 'Acme Stores', amount: 100 })]);
    expect(report.customerCollections).toEqual([expect.objectContaining({ customerName: 'Acme Stores', amount: 75 })]);
    expect(report.paymentDetails).toEqual([expect.objectContaining({ bankName: 'People Bank', origin: 'Acme Stores', reason: 'Invoice settlement', reference: 'CH-9' })]);
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

  describe('playback event isolation', () => {
    it('keeps applying independent events in a batch after one event is rejected', async () => {
      mockTx.syncEvent.findFirst.mockResolvedValue(null);
      mockTx.syncEvent.findMany.mockResolvedValue([]);
      mockTx.syncEvent.create.mockImplementation(async ({ data }: any) => ({
        ...data,
        createdAt: new Date('2026-08-14T10:00:00.000Z'),
      }));
      mockTx.pOSShift.findUnique.mockResolvedValue(null);
      mockTx.pOSShift.findFirst.mockResolvedValue(null);
      mockTx.pOSShift.upsert.mockResolvedValue({});
      mockTx.syncDeviceState.findUnique.mockResolvedValue(null);
      mockTx.syncDeviceState.findMany.mockResolvedValue([]);
      mockTx.syncDeviceState.upsert.mockResolvedValue({});
      mockTx.creditPayment.findUnique.mockResolvedValue(null);
      mockTx.customer.findUnique.mockResolvedValue(null);
      mockTx.syncConflict.findFirst.mockResolvedValue(null);
      mockTx.syncConflict.create.mockImplementation(async ({ data }: any) => ({
        ...data,
        createdAt: new Date('2026-08-14T10:05:00.000Z'),
        resolvedAt: null,
      }));

      // A batch that mixes two unrelated, valid shift events with one
      // credit-payment event referencing a customer that does not exist.
      // The bad event must be rejected and recorded as a conflict without
      // rolling back or skipping the valid shift events around it.
      const events = [
        {
          id: 'event-shift-1',
          aggregateType: 'shift',
          aggregateId: 'shift-ok-1',
          eventType: SyncEventType.SHIFT_OPENED,
          payload: { terminalId: 't1', branchId: 'b1', cashierId: 'cashier-1', openingFloat: 100 },
          deviceId: 'device-1',
          sequenceNum: 1,
          lamport: 1,
          vectorClock: { 'device-1': 1 },
          conflictPolicy: SyncConflictPolicy.LAST_WRITE_WINS,
          state: SyncEventState.PENDING,
          createdAt: '2026-08-14T09:59:00.000Z',
        },
        {
          id: 'event-payment-bad',
          aggregateType: 'credit-payment',
          aggregateId: 'payment-bad-1',
          eventType: SyncEventType.CREDIT_PAYMENT_RECORDED,
          payload: { customerId: 'missing-customer', amount: 100 },
          deviceId: 'device-1',
          sequenceNum: 2,
          lamport: 2,
          vectorClock: { 'device-1': 2 },
          conflictPolicy: SyncConflictPolicy.SERVER_WINS,
          state: SyncEventState.PENDING,
          createdAt: '2026-08-14T09:59:30.000Z',
        },
        {
          id: 'event-shift-2',
          aggregateType: 'shift',
          aggregateId: 'shift-ok-2',
          eventType: SyncEventType.SHIFT_OPENED,
          payload: { terminalId: 't2', branchId: 'b1', cashierId: 'cashier-2', openingFloat: 50 },
          deviceId: 'device-1',
          sequenceNum: 3,
          lamport: 3,
          vectorClock: { 'device-1': 3 },
          conflictPolicy: SyncConflictPolicy.LAST_WRITE_WINS,
          state: SyncEventState.PENDING,
          createdAt: '2026-08-14T10:00:00.000Z',
        },
      ];

      const result = await playbackEvents({
        deviceId: 'device-1',
        terminalId: 't1',
        vectorClock: {},
        events: events as any,
      });

      expect(result.acceptedEventIds).toEqual(['event-shift-1', 'event-shift-2']);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({
        remoteEventId: 'event-payment-bad',
        policy: 'SYNC_ERROR',
        status: 'OPEN',
      });
      expect(mockTx.pOSShift.upsert).toHaveBeenCalledTimes(2);
    });
  });
});
