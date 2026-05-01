import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
  getDB,
  resetDB,
  upsertProduct,
  getLocalStock,
  deductLocalInventory,
  restoreLocalInventory,
  openLocalShift,
  closeLocalShift,
  getActiveLocalShift,
  createLocalSale,
  getLocalSale,
  createLocalReturn,
  getPendingSyncOps,
  searchLocalProducts,
  getLocalProductByBarcode,
  LocalProduct,
} from '../offline/localDB';
import {
  SyncOperationType,
  InventoryState,
  PaymentMethod,
  ShiftStatus,
} from '@jingles/shared';

const TEST_DB_PATH = path.join(__dirname, `test-pos-${uuidv4()}.db`);

function seedInventory(productId: string, qty: number, state = InventoryState.ShelfReady) {
  const database = getDB(TEST_DB_PATH);
  for (let i = 0; i < qty; i++) {
    database
      .prepare('INSERT INTO local_inventory (id, product_id, state) VALUES (?, ?, ?)')
      .run(uuidv4(), productId, state);
  }
}

function seedProduct(
  overrides: Partial<{ id: string; sku: string; name: string; price: number; barcode: string }> = {}
): LocalProduct {
  const p: LocalProduct = {
    id: overrides.id ?? uuidv4(),
    sku: overrides.sku ?? `TEST-${uuidv4().slice(0, 6)}`,
    name: overrides.name ?? 'Test Product',
    price: overrides.price ?? 10.0,
    barcode: overrides.barcode,
    batchPrices: [],
  };
  upsertProduct(p);
  return p;
}

beforeAll(() => {
  getDB(TEST_DB_PATH);
});

afterAll(() => {
  resetDB();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

beforeEach(() => {
  const database = getDB(TEST_DB_PATH);
  database.exec(`
    DELETE FROM sync_queue;
    DELETE FROM local_return_lines;
    DELETE FROM local_returns;
    DELETE FROM local_payments;
    DELETE FROM local_sale_lines;
    DELETE FROM local_sales;
    DELETE FROM local_inventory;
    DELETE FROM local_shifts;
    DELETE FROM local_products;
  `);
});

describe('Offline product management', () => {
  it('upserts and retrieves products by barcode', () => {
    seedProduct({ sku: 'WIDGET-001', name: 'Widget', price: 9.99, barcode: '123456789' });

    const found = getLocalProductByBarcode('123456789');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Widget');
    expect(found!.price).toBe(9.99);
  });

  it('searches products by name', () => {
    seedProduct({ name: 'Apple Juice' });
    seedProduct({ name: 'Orange Juice' });
    seedProduct({ name: 'Water' });

    const results = searchLocalProducts('Juice');
    expect(results).toHaveLength(2);
  });
});

describe('Offline inventory', () => {
  it('deducts inventory correctly', () => {
    const p = seedProduct();
    seedInventory(p.id, 5);

    const ok = deductLocalInventory(p.id, 3);
    expect(ok).toBe(true);

    expect(getLocalStock(p.id, InventoryState.ShelfReady)).toBe(2);
    expect(getLocalStock(p.id, InventoryState.Sold)).toBe(3);
  });

  it('returns false when insufficient stock', () => {
    const p = seedProduct();
    seedInventory(p.id, 2);

    const ok = deductLocalInventory(p.id, 5);
    expect(ok).toBe(false);

    expect(getLocalStock(p.id, InventoryState.ShelfReady)).toBe(2);
  });

  it('restores inventory on return', () => {
    const p = seedProduct();
    restoreLocalInventory(p.id, 2);

    expect(getLocalStock(p.id, InventoryState.Returned)).toBe(2);
  });
});

describe('Offline shifts', () => {
  it('opens a shift locally', () => {
    const shift = openLocalShift({
      terminalId: 'TERM-001',
      userId: 'cashier-1',
      openingFloat: 50.0,
    });

    expect(shift.status).toBe(ShiftStatus.OPEN);
    expect(shift.terminalId).toBe('TERM-001');
    expect(shift.openingFloat).toBe(50.0);
  });

  it('returns existing open shift if already open', () => {
    const first = openLocalShift({ terminalId: 'TERM-001', userId: 'cashier-1' });
    const second = openLocalShift({ terminalId: 'TERM-001', userId: 'cashier-1' });

    const active = getActiveLocalShift('TERM-001');
    expect(active).toBeDefined();
    expect(second.id).toBe(first.id);
    expect(active!.id).toBe(first.id);
  });

  it('queues sync op when shift is opened', () => {
    openLocalShift({ terminalId: 'TERM-001', userId: 'cashier-1' });
    const pending = getPendingSyncOps();
    expect(pending.some((op) => op.type === SyncOperationType.OPEN_SHIFT)).toBe(true);
  });

  it('closes a shift and queues sync', () => {
    const shift = openLocalShift({ terminalId: 'TERM-001', userId: 'cashier-1' });
    closeLocalShift(shift.id, { closingFloat: 75.0, notes: 'End of day' });

    expect(getActiveLocalShift('TERM-001')).toBeUndefined();

    const pending = getPendingSyncOps();
    expect(pending.some((op) => op.type === SyncOperationType.CLOSE_SHIFT)).toBe(true);
  });
});

describe('Offline sale creation', () => {
  it('creates a sale locally and deducts inventory', () => {
    const p = seedProduct({ sku: 'SKU-001', name: 'Widget', price: 10.0 });
    seedInventory(p.id, 5);

    const shift = openLocalShift({ terminalId: 'TERM-001', userId: 'cashier-1' });

    const sale = createLocalSale({
      receiptNumber: 'RCP-TEST-001',
      terminalId: 'TERM-001',
      userId: 'cashier-1',
      shiftId: shift.id,
      lines: [
        {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          quantity: 2,
          unitPrice: 10.0,
          discountAmount: 0,
          lineTotal: 20.0,
        },
      ],
      payment: { method: PaymentMethod.CASH, amount: 20.0, cashReceived: 20.0, changeDue: 0 },
      subtotal: 20.0,
      discountTotal: 0,
      taxTotal: 0,
      total: 20.0,
    });

    expect(sale.status).toBe('COMPLETED');
    expect(sale.synced).toBe(false);
    expect(sale.offlineId).toBeDefined();
    expect(getLocalStock(p.id, InventoryState.ShelfReady)).toBe(3);
  });

  it('fails safely when offline stock is insufficient', () => {
    const p = seedProduct({ sku: 'SKU-002', name: 'Widget2', price: 10.0 });
    seedInventory(p.id, 1);

    expect(() =>
      createLocalSale({
        receiptNumber: 'RCP-TEST-002',
        terminalId: 'TERM-001',
        userId: 'cashier-1',
        lines: [
          {
            productId: p.id,
            sku: p.sku,
            name: p.name,
            quantity: 5,
            unitPrice: 10.0,
            discountAmount: 0,
            lineTotal: 50.0,
          },
        ],
        payment: { method: PaymentMethod.CASH, amount: 50.0 },
        subtotal: 50.0,
        discountTotal: 0,
        taxTotal: 0,
        total: 50.0,
      })
    ).toThrow('Insufficient local stock');

    expect(getLocalStock(p.id, InventoryState.ShelfReady)).toBe(1);
  });

  it('queues a CREATE_SALE sync operation after offline sale', () => {
    const p = seedProduct({ sku: 'SKU-003', name: 'Widget3', price: 5.0 });
    seedInventory(p.id, 3);

    createLocalSale({
      receiptNumber: 'RCP-TEST-003',
      terminalId: 'TERM-001',
      userId: 'cashier-1',
      lines: [
        {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          quantity: 1,
          unitPrice: 5.0,
          discountAmount: 0,
          lineTotal: 5.0,
        },
      ],
      payment: { method: PaymentMethod.CASH, amount: 5.0 },
      subtotal: 5.0,
      discountTotal: 0,
      taxTotal: 0,
      total: 5.0,
    });

    const pending = getPendingSyncOps();
    const saleOps = pending.filter((op) => op.type === SyncOperationType.CREATE_SALE);
    expect(saleOps).toHaveLength(1);

    const payload = JSON.parse(saleOps[0].payload);
    expect(payload.receiptNumber).toBe('RCP-TEST-003');
  });
});

describe('Offline returns', () => {
  it('creates a return and restores inventory as Returned', () => {
    const p = seedProduct({ sku: 'SKU-004', name: 'Widget4', price: 10.0 });
    seedInventory(p.id, 3);

    const sale = createLocalSale({
      receiptNumber: 'RCP-TEST-004',
      terminalId: 'TERM-001',
      userId: 'cashier-1',
      lines: [
        {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          quantity: 2,
          unitPrice: 10.0,
          discountAmount: 0,
          lineTotal: 20.0,
        },
      ],
      payment: { method: PaymentMethod.CASH, amount: 20.0 },
      subtotal: 20.0,
      discountTotal: 0,
      taxTotal: 0,
      total: 20.0,
    });

    const ret = createLocalReturn({
      saleId: sale.id,
      userId: 'cashier-1',
      terminalId: 'TERM-001',
      reason: 'Defective',
      lines: [
        {
          saleLineId: sale.lines[0].id,
          productId: p.id,
          quantity: 1,
          refundAmount: 10.0,
        },
      ],
    });

    expect(ret.totalRefund).toBe(10.0);
    expect(getLocalStock(p.id, InventoryState.Returned)).toBe(1);

    const pending = getPendingSyncOps();
    expect(pending.some((op) => op.type === SyncOperationType.CREATE_RETURN)).toBe(true);
  });
});
