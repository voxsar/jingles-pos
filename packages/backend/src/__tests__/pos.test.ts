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

const { buildZReport, confirmPlayback, getLocalSyncStatus, getServerVectorClock } = require('../services/posSync') as typeof import('../services/posSync');
const { authenticate, resolveUnlockMode } = require('../routes/auth') as typeof import('../routes/auth');
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
      countedDrawer: 650,
      variance: 10,
      paymentCounts: { CASH: 1, VISA: 1 },
      discountedLineCount: 1,
      productCount: 3,
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
});
