import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CartLine,
  DEFAULT_CASHIER_ID,
  DEFAULT_CUSTOMER_ID,
  DEFAULT_PAYMENT_METHOD,
  DEFAULT_TERMINAL_ID,
  SAMPLE_PRODUCTS,
  SAMPLE_USERS,
  SaleStatus,
  ShiftStatus,
  SyncEventType,
  UserRole,
} from '@jingles/shared';
import {
  bootstrapPOS,
  buildLocalZReport,
  clearLocalAuthSession,
  closeLocalShift,
  createLocalReturn,
  createLocalSale,
  getActiveLocalShift,
  getLocalAuthUser,
  getDB,
  getLocalSale,
  getPendingSyncEvents,
  loginLocalUser,
  listHeldSales,
  openLocalShift,
  recallHeldSale,
  resetDB,
  saveHeldSale,
  searchLocalProducts,
} from '../offline/localDB';

const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `jingles-pos-electron-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
);

const DEFAULT_BRANCH_ID = 'branch-jingles-01';
const PRODUCT = SAMPLE_PRODUCTS[0];
const SALESPERSON = SAMPLE_USERS.find((user) => user.role === UserRole.SALESPERSON) ?? SAMPLE_USERS[0]!;

function buildCartLine(quantity: number = 1): CartLine {
  const tier = PRODUCT.priceTiers[0]!;
  const discountAmount = 0;
  const unitPrice = tier.price;

  return {
    uid: `line-${quantity}`,
    productId: PRODUCT.id,
    sku: PRODUCT.sku,
    name: PRODUCT.name,
    barcode: PRODUCT.barcode,
    categoryId: PRODUCT.categoryId,
    subcategory: PRODUCT.subcategory,
    packSize: PRODUCT.packSize,
    quantity,
    unitPrice,
    tierLabel: tier.label,
    priceTiers: PRODUCT.priceTiers,
    salespersonId: SALESPERSON.id,
    salespersonName: SALESPERSON.name,
    salespersonInitials: SALESPERSON.initials,
    discountPercent: 0,
    discountAmount,
    costBasis: Math.round(unitPrice * 0.65 * 100) / 100,
    stockOnHand: PRODUCT.stockOnHand,
    lineTotal: unitPrice * quantity,
  };
}

beforeEach(() => {
  resetDB();
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
  getDB(TEST_DB_PATH);
});

afterAll(() => {
  resetDB();
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
});

describe('local SQLite playback-log backend', () => {
  it('bootstraps seeded data and sync status', () => {
    const bootstrap = bootstrapPOS({ terminalId: DEFAULT_TERMINAL_ID });

    expect(bootstrap.products.length).toBeGreaterThan(0);
    expect(bootstrap.customers.length).toBeGreaterThan(0);
    expect(bootstrap.syncStatus.deviceId).toBeTruthy();
    expect(bootstrap.syncStatus.pendingEvents).toBe(0);
  });

  it('creates and clears a local auth session without exposing the PIN', () => {
    const result = loginLocalUser({
      identifier: 'muslim.abdullah@jingles.local',
      password: '1042',
    });

    expect(result.token).toBeTruthy();
    expect(result.user.code).toBe('E1042');
    expect(result.user.pin).toBeUndefined();
    expect(getLocalAuthUser(result.token)?.email).toBe('muslim.abdullah@jingles.local');

    clearLocalAuthSession(result.token);
    expect(getLocalAuthUser(result.token)).toBeNull();
  });

  it('searches products through the SQLite FTS index', () => {
    const rows = searchLocalProducts('liquid found');

    expect(rows[0]?.sku).toBe('2010023');
    expect(rows[0]?.name).toContain('Liquid Foundation');
  });

  it('opens and closes shifts as local events', () => {
    const shift = openLocalShift({
      terminalId: DEFAULT_TERMINAL_ID,
      branchId: DEFAULT_BRANCH_ID,
      cashierId: DEFAULT_CASHIER_ID,
      openingFloat: 2500,
    });

    expect(shift.status).toBe(ShiftStatus.OPEN);
    expect(getActiveLocalShift(DEFAULT_TERMINAL_ID)?.id).toBe(shift.id);
    expect(getPendingSyncEvents().some((event) => event.eventType === SyncEventType.SHIFT_OPENED)).toBe(true);

    const closedShift = closeLocalShift({
      shiftId: shift.id,
      terminalId: DEFAULT_TERMINAL_ID,
      closingFloat: 3100,
      notes: 'Close of day',
    });

    expect(closedShift.status).toBe(ShiftStatus.CLOSED);
    expect(getActiveLocalShift(DEFAULT_TERMINAL_ID)).toBeUndefined();
    expect(getPendingSyncEvents().some((event) => event.eventType === SyncEventType.SHIFT_CLOSED)).toBe(true);
  });

  it('holds and recalls bills through the event log', () => {
    const heldSale = saveHeldSale({
      terminalId: DEFAULT_TERMINAL_ID,
      branchId: DEFAULT_BRANCH_ID,
      cashierId: DEFAULT_CASHIER_ID,
      customerId: DEFAULT_CUSTOMER_ID,
      lines: [buildCartLine(2)],
      discountTotal: 0,
      subtotal: PRODUCT.priceTiers[0]!.price * 2,
      total: PRODUCT.priceTiers[0]!.price * 2,
    });

    expect(listHeldSales()).toHaveLength(1);
    expect(heldSale.status).toBe(SaleStatus.HELD);

    const recalled = recallHeldSale(heldSale.id, DEFAULT_TERMINAL_ID);

    expect(recalled?.id).toBe(heldSale.id);
    expect(listHeldSales()).toHaveLength(0);
    expect(getPendingSyncEvents().some((event) => event.eventType === SyncEventType.HELD_SALE_RECALLED)).toBe(true);
  });

  it('creates sales and returns, then rolls them into the local Z report', () => {
    const shift = openLocalShift({
      terminalId: DEFAULT_TERMINAL_ID,
      branchId: DEFAULT_BRANCH_ID,
      cashierId: DEFAULT_CASHIER_ID,
      openingFloat: 1000,
    });

    const line = buildCartLine(2);
    const sale = createLocalSale({
      receiptNumber: '260521-TERM03-0001',
      terminalId: DEFAULT_TERMINAL_ID,
      branchId: DEFAULT_BRANCH_ID,
      cashierId: DEFAULT_CASHIER_ID,
      customerId: DEFAULT_CUSTOMER_ID,
      shiftId: shift.id,
      lines: [line],
      payments: [{ method: DEFAULT_PAYMENT_METHOD, amount: line.lineTotal, tenderedAmount: line.lineTotal, changeDue: 0 }],
      discountTotal: 0,
      subtotal: line.lineTotal,
      taxTotal: 0,
      total: line.lineTotal,
      marginTotal: line.quantity * (line.unitPrice - line.costBasis),
    });

    expect(sale.status).toBe(SaleStatus.COMPLETED);
    expect(getLocalSale(sale.id)?.receiptNumber).toBe('260521-TERM03-0001');
    expect(getPendingSyncEvents().some((event) => event.eventType === SyncEventType.SALE_COMPLETED)).toBe(true);

    const refund = createLocalReturn({
      saleId: sale.id,
      terminalId: DEFAULT_TERMINAL_ID,
      cashierId: DEFAULT_CASHIER_ID,
      reason: 'Customer return',
      lines: [{
        saleLineId: sale.lines[0]!.id,
        productId: PRODUCT.id,
        quantity: 1,
        refundAmount: line.unitPrice,
      }],
    });

    expect(refund.totalRefund).toBe(line.unitPrice);
    expect(getPendingSyncEvents().some((event) => event.eventType === SyncEventType.RETURN_CREATED)).toBe(true);

    const zReport = buildLocalZReport(shift.id);
    expect(zReport.transactionCount).toBe(1);
    expect(zReport.grossSales).toBe(line.lineTotal);
    expect(zReport.refunds).toBe(line.unitPrice);
    expect(zReport.paymentBreakdown[DEFAULT_PAYMENT_METHOD]).toBe(line.lineTotal);
  });
});
