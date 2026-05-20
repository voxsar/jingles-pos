import { CashCountMode } from '@jingles/shared';

const mockTx = {
  syncDeviceState: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
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
    pOSShift: mockTx.pOSShift,
  },
}));

const { buildZReport, confirmPlayback, getServerVectorClock } = require('../services/posSync') as typeof import('../services/posSync');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('event sourced POS backend services', () => {
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
        },
        {
          subtotal: 100,
          discountTotal: 0,
          total: 100,
          payments: [{ method: 'VISA', amount: 100 }],
          returns: [],
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
    });
  });
});
