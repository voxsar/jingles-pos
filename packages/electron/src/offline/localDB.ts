import Database from 'better-sqlite3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  SaleStatus,
  ShiftStatus,
  SyncOperationType,
  SyncStatus,
  PaymentMethod,
  InventoryState,
} from '@jingles/shared';

let _db: Database.Database | null = null;

export function getDB(dbPath?: string): Database.Database {
  if (_db) return _db;

  const filePath = dbPath || path.join(process.cwd(), 'jingles-pos-local.db');
  _db = new Database(filePath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

export function resetDB(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_products (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      barcode TEXT UNIQUE,
      price REAL NOT NULL,
      batch_prices TEXT DEFAULT '[]',
      synced_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS local_inventory (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'ShelfReady',
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (product_id) REFERENCES local_products(id)
    );

    CREATE TABLE IF NOT EXISTS local_shifts (
      id TEXT PRIMARY KEY,
      terminal_id TEXT NOT NULL,
      branch_id TEXT,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      opening_float REAL DEFAULT 0,
      closing_float REAL,
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT,
      notes TEXT,
      synced INTEGER DEFAULT 0,
      offline_id TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS local_sales (
      id TEXT PRIMARY KEY,
      receipt_number TEXT NOT NULL UNIQUE,
      terminal_id TEXT NOT NULL,
      branch_id TEXT,
      user_id TEXT NOT NULL,
      customer_id TEXT,
      shift_id TEXT,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      subtotal REAL NOT NULL,
      discount_total REAL DEFAULT 0,
      tax_total REAL DEFAULT 0,
      total REAL NOT NULL,
      offline_id TEXT UNIQUE,
      synced INTEGER DEFAULT 0,
      sync_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (shift_id) REFERENCES local_shifts(id)
    );

    CREATE TABLE IF NOT EXISTS local_sale_lines (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      barcode TEXT,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      discount_amount REAL DEFAULT 0,
      line_total REAL NOT NULL,
      FOREIGN KEY (sale_id) REFERENCES local_sales(id)
    );

    CREATE TABLE IF NOT EXISTS local_payments (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      method TEXT NOT NULL,
      amount REAL NOT NULL,
      cash_received REAL,
      change_due REAL,
      reference TEXT,
      FOREIGN KEY (sale_id) REFERENCES local_sales(id)
    );

    CREATE TABLE IF NOT EXISTS local_returns (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      reason TEXT,
      total_refund REAL NOT NULL,
      synced INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (sale_id) REFERENCES local_sales(id)
    );

    CREATE TABLE IF NOT EXISTS local_return_lines (
      id TEXT PRIMARY KEY,
      return_id TEXT NOT NULL,
      sale_line_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      refund_amount REAL NOT NULL,
      FOREIGN KEY (return_id) REFERENCES local_returns(id)
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      attempts INTEGER DEFAULT 0,
      last_error TEXT
    );
  `);
}

// ── Products ───────────────────────────────────────────────────────────────

export interface LocalProduct {
  id: string;
  sku: string;
  name: string;
  barcode?: string;
  price: number;
  batchPrices: Array<{ minQty: number; price: number }>;
}

export function upsertProduct(product: LocalProduct): void {
  const db = getDB();
  db.prepare(`
    INSERT INTO local_products (id, sku, name, barcode, price, batch_prices, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      sku = excluded.sku,
      name = excluded.name,
      barcode = excluded.barcode,
      price = excluded.price,
      batch_prices = excluded.batch_prices,
      synced_at = excluded.synced_at,
      updated_at = datetime('now')
  `).run(
    product.id,
    product.sku,
    product.name,
    product.barcode ?? null,
    product.price,
    JSON.stringify(product.batchPrices ?? [])
  );
}

export function searchLocalProducts(query: string): LocalProduct[] {
  const db = getDB();
  const rows = db.prepare(`
    SELECT * FROM local_products
    WHERE name LIKE ? OR sku LIKE ? OR barcode = ?
    LIMIT 20
  `).all(`%${query}%`, `%${query}%`, query) as any[];

  return rows.map(rowToProduct);
}

export function getLocalProductByBarcode(barcode: string): LocalProduct | undefined {
  const db = getDB();
  const row = db.prepare('SELECT * FROM local_products WHERE barcode = ?').get(barcode) as any;
  return row ? rowToProduct(row) : undefined;
}

function rowToProduct(row: any): LocalProduct {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    barcode: row.barcode ?? undefined,
    price: row.price,
    batchPrices: JSON.parse(row.batch_prices || '[]'),
  };
}

// ── Inventory ──────────────────────────────────────────────────────────────

export function getLocalStock(productId: string, state: string = InventoryState.ShelfReady): number {
  const db = getDB();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM local_inventory
    WHERE product_id = ? AND state = ?
  `).get(productId, state) as { count: number };
  return row.count;
}

export function deductLocalInventory(productId: string, quantity: number): boolean {
  const db = getDB();
  const available = db.prepare(`
    SELECT id FROM local_inventory
    WHERE product_id = ? AND state = ?
    LIMIT ?
  `).all(productId, InventoryState.ShelfReady, quantity) as { id: string }[];

  if (available.length < quantity) return false;

  const ids = available.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE local_inventory SET state = ?, updated_at = datetime('now')
    WHERE id IN (${placeholders})
  `).run(InventoryState.Sold, ...ids);

  return true;
}

export function restoreLocalInventory(productId: string, quantity: number): void {
  const db = getDB();
  for (let i = 0; i < quantity; i++) {
    db.prepare(`
      INSERT INTO local_inventory (id, product_id, state)
      VALUES (?, ?, ?)
    `).run(uuidv4(), productId, InventoryState.Returned);
  }
}

// ── Shifts ─────────────────────────────────────────────────────────────────

export interface LocalShift {
  id: string;
  terminalId: string;
  branchId?: string;
  userId: string;
  status: string;
  openingFloat: number;
  closingFloat?: number;
  openedAt: string;
  closedAt?: string;
  notes?: string;
  synced: boolean;
  offlineId?: string;
}

export function openLocalShift(data: {
  terminalId: string;
  branchId?: string;
  userId: string;
  openingFloat?: number;
}): LocalShift {
  const db = getDB();

  const existing = db.prepare(`
    SELECT * FROM local_shifts WHERE terminal_id = ? AND status = ?
  `).get(data.terminalId, ShiftStatus.OPEN) as any;

  if (existing) return rowToShift(existing);

  const id = uuidv4();
  const offlineId = `shift-offline-${id}`;

  db.prepare(`
    INSERT INTO local_shifts (id, terminal_id, branch_id, user_id, opening_float, status, offline_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.terminalId, data.branchId ?? null, data.userId, data.openingFloat ?? 0, ShiftStatus.OPEN, offlineId);

  enqueueSyncOp(SyncOperationType.OPEN_SHIFT, { ...data, offlineId });

  return rowToShift(db.prepare('SELECT * FROM local_shifts WHERE id = ?').get(id) as any);
}

export function closeLocalShift(shiftId: string, data: { closingFloat?: number; notes?: string }): LocalShift {
  const db = getDB();

  db.prepare(`
    UPDATE local_shifts SET status = ?, closing_float = ?, closed_at = datetime('now'), notes = ?
    WHERE id = ?
  `).run(ShiftStatus.CLOSED, data.closingFloat ?? null, data.notes ?? null, shiftId);

  enqueueSyncOp(SyncOperationType.CLOSE_SHIFT, { shiftId, ...data });

  return rowToShift(db.prepare('SELECT * FROM local_shifts WHERE id = ?').get(shiftId) as any);
}

export function getActiveLocalShift(terminalId: string): LocalShift | undefined {
  const db = getDB();
  const row = db.prepare(`
    SELECT * FROM local_shifts WHERE terminal_id = ? AND status = ?
  `).get(terminalId, ShiftStatus.OPEN) as any;
  return row ? rowToShift(row) : undefined;
}

function rowToShift(row: any): LocalShift {
  return {
    id: row.id,
    terminalId: row.terminal_id,
    branchId: row.branch_id ?? undefined,
    userId: row.user_id,
    status: row.status,
    openingFloat: row.opening_float,
    closingFloat: row.closing_float ?? undefined,
    openedAt: row.opened_at,
    closedAt: row.closed_at ?? undefined,
    notes: row.notes ?? undefined,
    synced: row.synced === 1,
    offlineId: row.offline_id ?? undefined,
  };
}

// ── Sales ──────────────────────────────────────────────────────────────────

export interface LocalSaleLine {
  id: string;
  saleId: string;
  productId: string;
  sku: string;
  name: string;
  barcode?: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  lineTotal: number;
}

export interface LocalPayment {
  id: string;
  saleId: string;
  method: string;
  amount: number;
  cashReceived?: number;
  changeDue?: number;
  reference?: string;
}

export interface LocalSale {
  id: string;
  receiptNumber: string;
  terminalId: string;
  branchId?: string;
  userId: string;
  customerId?: string;
  shiftId?: string;
  status: string;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  offlineId?: string;
  synced: boolean;
  syncError?: string;
  createdAt: string;
  lines: LocalSaleLine[];
  payments: LocalPayment[];
}

export interface CreateLocalSaleInput {
  receiptNumber: string;
  terminalId: string;
  branchId?: string;
  userId: string;
  customerId?: string;
  shiftId?: string;
  lines: Omit<LocalSaleLine, 'id' | 'saleId'>[];
  payment: Omit<LocalPayment, 'id' | 'saleId'>;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
}

export function createLocalSale(input: CreateLocalSaleInput): LocalSale {
  const db = getDB();
  const id = uuidv4();
  const offlineId = `sale-offline-${id}`;

  const txn = db.transaction(() => {
    for (const line of input.lines) {
      const ok = deductLocalInventory(line.productId, line.quantity);
      if (!ok) {
        throw new Error(`Insufficient local stock for product ${line.productId}`);
      }
    }

    db.prepare(`
      INSERT INTO local_sales (
        id, receipt_number, terminal_id, branch_id, user_id, customer_id, shift_id,
        status, subtotal, discount_total, tax_total, total, offline_id, synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id, input.receiptNumber, input.terminalId, input.branchId ?? null,
      input.userId, input.customerId ?? null, input.shiftId ?? null,
      SaleStatus.COMPLETED, input.subtotal, input.discountTotal,
      input.taxTotal, input.total, offlineId
    );

    for (const line of input.lines) {
      db.prepare(`
        INSERT INTO local_sale_lines (id, sale_id, product_id, sku, name, barcode, quantity, unit_price, discount_amount, line_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), id, line.productId, line.sku, line.name, line.barcode ?? null,
        line.quantity, line.unitPrice, line.discountAmount, line.lineTotal
      );
    }

    const p = input.payment;
    db.prepare(`
      INSERT INTO local_payments (id, sale_id, method, amount, cash_received, change_due, reference)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), id, p.method, p.amount,
      p.cashReceived ?? null, p.changeDue ?? null, p.reference ?? null
    );

    enqueueSyncOp(SyncOperationType.CREATE_SALE, { ...input, offlineId });
  });

  txn();

  return getLocalSale(id)!;
}

export function getLocalSale(id: string): LocalSale | undefined {
  const db = getDB();
  const row = db.prepare('SELECT * FROM local_sales WHERE id = ?').get(id) as any;
  if (!row) return undefined;

  const lines = db.prepare('SELECT * FROM local_sale_lines WHERE sale_id = ?').all(id) as any[];
  const payments = db.prepare('SELECT * FROM local_payments WHERE sale_id = ?').all(id) as any[];

  return rowToSale(row, lines, payments);
}

export function listLocalSales(): LocalSale[] {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM local_sales ORDER BY created_at DESC').all() as any[];
  return rows.map((row) => {
    const lines = db.prepare('SELECT * FROM local_sale_lines WHERE sale_id = ?').all(row.id) as any[];
    const payments = db.prepare('SELECT * FROM local_payments WHERE sale_id = ?').all(row.id) as any[];
    return rowToSale(row, lines, payments);
  });
}

function rowToSale(row: any, lines: any[], payments: any[]): LocalSale {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    terminalId: row.terminal_id,
    branchId: row.branch_id ?? undefined,
    userId: row.user_id,
    customerId: row.customer_id ?? undefined,
    shiftId: row.shift_id ?? undefined,
    status: row.status,
    subtotal: row.subtotal,
    discountTotal: row.discount_total,
    taxTotal: row.tax_total,
    total: row.total,
    offlineId: row.offline_id ?? undefined,
    synced: row.synced === 1,
    syncError: row.sync_error ?? undefined,
    createdAt: row.created_at,
    lines: lines.map((l) => ({
      id: l.id,
      saleId: l.sale_id,
      productId: l.product_id,
      sku: l.sku,
      name: l.name,
      barcode: l.barcode ?? undefined,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      discountAmount: l.discount_amount,
      lineTotal: l.line_total,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      saleId: p.sale_id,
      method: p.method,
      amount: p.amount,
      cashReceived: p.cash_received ?? undefined,
      changeDue: p.change_due ?? undefined,
      reference: p.reference ?? undefined,
    })),
  };
}

// ── Returns ────────────────────────────────────────────────────────────────

export interface LocalReturn {
  id: string;
  saleId: string;
  userId: string;
  terminalId: string;
  reason?: string;
  totalRefund: number;
  synced: boolean;
  createdAt: string;
}

export function createLocalReturn(data: {
  saleId: string;
  userId: string;
  terminalId: string;
  reason?: string;
  lines: Array<{ saleLineId: string; productId: string; quantity: number; refundAmount: number }>;
}): LocalReturn {
  const db = getDB();
  const id = uuidv4();
  const totalRefund = data.lines.reduce((s, l) => s + l.refundAmount, 0);

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO local_returns (id, sale_id, user_id, terminal_id, reason, total_refund)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.saleId, data.userId, data.terminalId, data.reason ?? null, totalRefund);

    for (const line of data.lines) {
      db.prepare(`
        INSERT INTO local_return_lines (id, return_id, sale_line_id, product_id, quantity, refund_amount)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), id, line.saleLineId, line.productId, line.quantity, line.refundAmount);

      restoreLocalInventory(line.productId, line.quantity);
    }

    enqueueSyncOp(SyncOperationType.CREATE_RETURN, data);
  });

  txn();

  return {
    id,
    saleId: data.saleId,
    userId: data.userId,
    terminalId: data.terminalId,
    reason: data.reason,
    totalRefund,
    synced: false,
    createdAt: new Date().toISOString(),
  };
}

// ── Sync Queue ─────────────────────────────────────────────────────────────

export interface SyncQueueItem {
  id: string;
  type: SyncOperationType;
  status: SyncStatus;
  payload: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export function enqueueSyncOp(type: SyncOperationType, payload: object): SyncQueueItem {
  const db = getDB();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO sync_queue (id, type, status, payload)
    VALUES (?, ?, ?, ?)
  `).run(id, type, SyncStatus.PENDING, JSON.stringify(payload));

  return {
    id,
    type,
    status: SyncStatus.PENDING,
    payload: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
}

export function getPendingSyncOps(): SyncQueueItem[] {
  const db = getDB();
  const rows = db.prepare(`
    SELECT * FROM sync_queue WHERE status = ? ORDER BY created_at ASC
  `).all(SyncStatus.PENDING) as any[];

  return rows.map(rowToSyncItem);
}

export function markSyncOpStatus(id: string, status: SyncStatus, error?: string): void {
  const db = getDB();
  db.prepare(`
    UPDATE sync_queue SET status = ?, last_error = ?, attempts = attempts + 1
    WHERE id = ?
  `).run(status, error ?? null, id);
}

export function markSaleAsSynced(offlineId: string, _serverId: string): void {
  const db = getDB();
  db.prepare(`
    UPDATE local_sales SET synced = 1, sync_error = NULL
    WHERE offline_id = ?
  `).run(offlineId);
}

export function getAllSyncOps(): SyncQueueItem[] {
  const db = getDB();
  const rows = db.prepare('SELECT * FROM sync_queue ORDER BY created_at DESC').all() as any[];
  return rows.map(rowToSyncItem);
}

function rowToSyncItem(row: any): SyncQueueItem {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload: row.payload,
    createdAt: row.created_at,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
  };
}
