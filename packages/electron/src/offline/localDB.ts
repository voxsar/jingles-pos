import Database from 'better-sqlite3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  Branch,
  CartLine,
  CashCountMode,
  DrawerContents,
  PaymentMethod,
  Category,
  CompleteSaleInput,
  Customer,
  DEFAULT_DEVICE_ID,
  DEFAULT_TERMINAL_ID,
  HeldSaleSummary,
  HoldSaleInput,
  PaymentInput,
  POSAuthLoginInput,
  POSAuthResult,
  POSBootstrap,
  POSSyncDashboard,
  POSUser,
  Product,
  ProductPriceTier,
  ProductVariant,
  ReturnInput,
  SaleStatus,
  SaleSummary,
  SAMPLE_BRANCHES,
  SAMPLE_CUSTOMERS,
  SAMPLE_TERMINALS,
  SAMPLE_USERS,
  SharedCatalogSnapshot,
  ShiftCloseInput,
  ShiftOpenInput,
  ShiftStatus,
  ShiftSummary,
  SyncConflict,
  SyncConflictPolicy,
  SyncConflictStatus,
  SyncEvent,
  SyncEventState,
  SyncEventType,
  SyncStatusSummary,
  Terminal,
  VectorClock,
  ZReportSummary,
} from '@jingles/shared';

let dbInstance: Database.Database | null = null;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseProductVariants(value: string | null | undefined): ProductVariant[] {
  const parsed = parseJson<ProductVariant[]>(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function applyVariantStockDelta(
  variants: ProductVariant[],
  variantId: string | null | undefined,
  delta: number,
): ProductVariant[] {
  if (!variantId) {
    return variants;
  }

  return variants.map((variant) => (
    variant.id === variantId
      ? {
          ...variant,
          stockOnHand: variant.stockOnHand + delta,
        }
      : variant
  ));
}

function normalizeClock(value: string | null | undefined): VectorClock {
  return parseJson<VectorClock>(value, {});
}

function compareVectorClocks(left: VectorClock, right: VectorClock): 'equal' | 'lt' | 'gt' | 'concurrent' {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let leftGreater = false;
  let rightGreater = false;

  for (const key of keys) {
    const a = left[key] ?? 0;
    const b = right[key] ?? 0;
    if (a > b) {
      leftGreater = true;
    }
    if (a < b) {
      rightGreater = true;
    }
  }

  if (!leftGreater && !rightGreater) {
    return 'equal';
  }
  if (leftGreater && !rightGreater) {
    return 'gt';
  }
  if (!leftGreater && rightGreater) {
    return 'lt';
  }
  return 'concurrent';
}

function compareEventOrder(
  leftSequence: number,
  leftDeviceId: string,
  rightSequence: number,
  rightDeviceId: string,
): number {
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  return leftDeviceId.localeCompare(rightDeviceId);
}

function eventWins(
  incoming: Pick<SyncEvent, 'deviceId' | 'sequenceNum' | 'conflictPolicy'>,
  current: Pick<SyncEvent, 'deviceId' | 'sequenceNum'>,
): boolean {
  if (incoming.conflictPolicy === SyncConflictPolicy.SERVER_WINS) {
    const incomingServer = incoming.deviceId.startsWith('server:');
    const currentServer = current.deviceId.startsWith('server:');
    if (incomingServer !== currentServer) {
      return incomingServer;
    }
  }

  return compareEventOrder(
    incoming.sequenceNum,
    incoming.deviceId,
    current.sequenceNum,
    current.deviceId,
  ) >= 0;
}

function resolveConflictPolicy(eventType: SyncEventType): SyncConflictPolicy {
  switch (eventType) {
    case SyncEventType.SALE_COMPLETED:
    case SyncEventType.SALE_VOIDED:
    case SyncEventType.RETURN_CREATED:
    case SyncEventType.SHIFT_CLOSED:
      return SyncConflictPolicy.SERVER_WINS;
    default:
      return SyncConflictPolicy.LAST_WRITE_WINS;
  }
}

function mergeClocks(...clocks: VectorClock[]): VectorClock {
  const result: VectorClock = {};
  for (const clock of clocks) {
    for (const [deviceId, sequence] of Object.entries(clock)) {
      result[deviceId] = Math.max(result[deviceId] ?? 0, sequence);
    }
  }
  return result;
}

function createAuthToken() {
  return `pos-${Date.now().toString(36)}-${uuidv4()}`;
}

function hasColumn(db: Database.Database, table: string, column: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function buildFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/["*()\[\]{}^~?:\\]/g, '').trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return '';
  }

  const last = tokens.pop()!;
  return [...tokens, `${last}*`].join(' ');
}

function rebuildProductSearchIndex(db: Database.Database) {
  db.exec('DELETE FROM products_fts;');
  db.prepare(`
    INSERT INTO products_fts (id, sku, barcode, name, subcategory, description)
    SELECT id, sku, COALESCE(barcode, ''), name, subcategory, COALESCE(description, '')
    FROM products
  `).run();
}

function mapUserRow(row: any): POSUser {
  return {
    id: row.id,
    code: row.code,
    email: row.email ?? undefined,
    name: row.name,
    initials: row.initials,
    role: row.role,
    pin: row.pin ?? undefined,
  };
}

function sanitizeUser(user: POSUser): POSUser {
  const { pin: _pin, ...rest } = user;
  return rest;
}

function findUserByIdentifier(db: Database.Database, identifier: string): POSUser | null {
  const normalized = identifier.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const row = db.prepare(`
    SELECT *
    FROM users
    WHERE lower(code) = ? OR lower(COALESCE(email, '')) = ?
    LIMIT 1
  `).get(normalized, normalized) as any;

  return row ? mapUserRow(row) : null;
}

export function getDB(dbPath?: string): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const filePath = dbPath || path.join(process.cwd(), 'jingles-pos-local.db');
  dbInstance = new Database(filePath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  initSchema(dbInstance);
  seedReferenceData(dbInstance);
  ensureDeviceState(dbInstance, DEFAULT_DEVICE_ID, DEFAULT_TERMINAL_ID);
  return dbInstance;
}

export function resetDB(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS terminals (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      branch_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      email TEXT,
      name TEXT NOT NULL,
      initials TEXT NOT NULL,
      role TEXT NOT NULL,
      pin TEXT
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      code TEXT,
      name TEXT NOT NULL,
      tier TEXT NOT NULL,
      phone TEXT,
      email TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      barcode TEXT,
      name TEXT NOT NULL,
      category_id TEXT NOT NULL,
      subcategory TEXT NOT NULL DEFAULT '',
      pack_size INTEGER NOT NULL DEFAULT 1,
      unit_label TEXT NOT NULL DEFAULT 'pcs',
      stock_on_hand INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      variants_json TEXT,
      last_vector_clock TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS product_price_tiers (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      label TEXT NOT NULL,
      price REAL NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      min_qty INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY,
      terminal_id TEXT NOT NULL,
      branch_id TEXT,
      cashier_id TEXT NOT NULL,
      status TEXT NOT NULL,
      opening_float REAL NOT NULL DEFAULT 0,
      closing_float REAL,
      notes TEXT,
      last_vector_clock TEXT DEFAULT '{}',
      opened_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS shift_cash_counts (
      id TEXT PRIMARY KEY,
      shift_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      total REAL NOT NULL,
      denominations_json TEXT NOT NULL,
      variance REAL,
      tenders_json TEXT,
      tender_mode TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS held_sales (
      id TEXT PRIMARY KEY,
      hold_number TEXT NOT NULL UNIQUE,
      terminal_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      cashier_id TEXT NOT NULL,
      customer_id TEXT,
      customer_name TEXT,
      status TEXT NOT NULL,
      subtotal REAL NOT NULL,
      discount_total REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      notes TEXT,
      last_vector_clock TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS held_sale_lines (
      id TEXT PRIMARY KEY,
      held_sale_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      variant_id TEXT,
      variant_code TEXT,
      variant_name TEXT,
      variant_attributes_json TEXT,
      subcategory TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      tier_label TEXT NOT NULL,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      salesperson_id TEXT,
      cost_basis REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      receipt_number TEXT NOT NULL UNIQUE,
      terminal_id TEXT NOT NULL,
      branch_id TEXT,
      cashier_id TEXT NOT NULL,
      customer_id TEXT,
      shift_id TEXT,
      held_sale_id TEXT,
      status TEXT NOT NULL,
      subtotal REAL NOT NULL,
      discount_total REAL NOT NULL DEFAULT 0,
      tax_total REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      margin_total REAL NOT NULL DEFAULT 0,
      source_device_id TEXT,
      source_sequence_num INTEGER,
      last_vector_clock TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sale_lines (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      barcode TEXT,
      variant_id TEXT,
      variant_code TEXT,
      variant_name TEXT,
      variant_attributes_json TEXT,
      subcategory TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      tier_label TEXT NOT NULL,
      discount_percent REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      salesperson_id TEXT,
      cost_basis REAL NOT NULL DEFAULT 0,
      margin_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      method TEXT NOT NULL,
      amount REAL NOT NULL,
      tendered_amount REAL,
      change_due REAL,
      reference TEXT,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      cashier_id TEXT NOT NULL,
      reason TEXT,
      total_refund REAL NOT NULL,
      source_device_id TEXT,
      source_sequence_num INTEGER,
      last_vector_clock TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS return_lines (
      id TEXT PRIMARY KEY,
      return_id TEXT NOT NULL,
      sale_line_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      variant_id TEXT,
      quantity INTEGER NOT NULL,
      refund_amount REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_event_log (
      id TEXT PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      device_id TEXT NOT NULL,
      terminal_id TEXT,
      sequence_num INTEGER NOT NULL,
      lamport INTEGER NOT NULL,
      vector_clock_json TEXT NOT NULL,
      conflict_policy TEXT NOT NULL,
      state TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_event_device_sequence
      ON sync_event_log(device_id, sequence_num);

    CREATE INDEX IF NOT EXISTS idx_sync_event_aggregate
      ON sync_event_log(aggregate_type, aggregate_id);

    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id TEXT PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      local_event_id TEXT,
      remote_event_id TEXT,
      policy TEXT NOT NULL,
      status TEXT NOT NULL,
      detail_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS device_state (
      device_id TEXT PRIMARY KEY,
      terminal_id TEXT NOT NULL,
      last_sequence_num INTEGER NOT NULL DEFAULT 0,
      local_vector_clock TEXT NOT NULL DEFAULT '{}',
      remote_vector_clock TEXT NOT NULL DEFAULT '{}',
      confirmed_vector_clock TEXT NOT NULL DEFAULT '{}',
      online INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
      ON auth_sessions(user_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
      id UNINDEXED,
      sku,
      barcode,
      name,
      subcategory,
      description
    );

    CREATE TRIGGER IF NOT EXISTS products_ai
    AFTER INSERT ON products
    BEGIN
      INSERT INTO products_fts (id, sku, barcode, name, subcategory, description)
      VALUES (new.id, new.sku, COALESCE(new.barcode, ''), new.name, new.subcategory, COALESCE(new.description, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS products_ad
    AFTER DELETE ON products
    BEGIN
      DELETE FROM products_fts WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS products_au
    AFTER UPDATE ON products
    BEGIN
      DELETE FROM products_fts WHERE id = old.id;
      INSERT INTO products_fts (id, sku, barcode, name, subcategory, description)
      VALUES (new.id, new.sku, COALESCE(new.barcode, ''), new.name, new.subcategory, COALESCE(new.description, ''));
    END;
  `);

  ensureColumn(db, 'users', 'email', 'TEXT');
  ensureColumn(db, 'products', 'variants_json', 'TEXT');
  ensureColumn(db, 'held_sale_lines', 'variant_id', 'TEXT');
  ensureColumn(db, 'held_sale_lines', 'variant_code', 'TEXT');
  ensureColumn(db, 'held_sale_lines', 'variant_name', 'TEXT');
  ensureColumn(db, 'held_sale_lines', 'variant_attributes_json', 'TEXT');
  ensureColumn(db, 'sale_lines', 'variant_id', 'TEXT');
  ensureColumn(db, 'sale_lines', 'variant_code', 'TEXT');
  ensureColumn(db, 'sale_lines', 'variant_name', 'TEXT');
  ensureColumn(db, 'sale_lines', 'variant_attributes_json', 'TEXT');
  ensureColumn(db, 'return_lines', 'variant_id', 'TEXT');
  ensureColumn(db, 'shift_cash_counts', 'tenders_json', 'TEXT');
  ensureColumn(db, 'shift_cash_counts', 'tender_mode', 'TEXT');
  ensureColumn(db, 'shift_cash_counts', 'reason', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);
}

function seedReferenceData(db: Database.Database): void {
  const transaction = db.transaction(() => {
    for (const branch of SAMPLE_BRANCHES) {
      db.prepare(`
        INSERT INTO branches (id, code, name)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          code = excluded.code,
          name = excluded.name
      `).run(branch.id, branch.code, branch.name);
    }

    for (const terminal of SAMPLE_TERMINALS) {
      db.prepare(`
        INSERT INTO terminals (id, code, name, branch_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          code = excluded.code,
          name = excluded.name,
          branch_id = excluded.branch_id
      `).run(terminal.id, terminal.code, terminal.name, terminal.branchId);
    }

    for (const user of SAMPLE_USERS) {
      db.prepare(`
        INSERT INTO users (id, code, email, name, initials, role, pin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          code = excluded.code,
          email = COALESCE(users.email, excluded.email),
          name = excluded.name,
          initials = excluded.initials,
          role = excluded.role,
          pin = COALESCE(users.pin, excluded.pin)
      `).run(
        user.id,
        user.code,
        user.email ?? null,
        user.name,
        user.initials,
        user.role,
        user.pin ?? null,
      );
    }

    for (const customer of SAMPLE_CUSTOMERS) {
      db.prepare(`
        INSERT INTO customers (id, code, name, tier, phone, email)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          code = excluded.code,
          name = excluded.name,
          tier = excluded.tier,
          phone = excluded.phone,
          email = excluded.email
      `).run(customer.id, customer.code, customer.name, customer.tier, customer.phone ?? null, customer.email ?? null);
    }
  });

  transaction();
  rebuildProductSearchIndex(db);
}

export function replaceCatalogSnapshot(snapshot: SharedCatalogSnapshot): void {
  const db = getDB();
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM product_price_tiers').run();
    db.prepare('DELETE FROM products').run();
    db.prepare('DELETE FROM categories').run();

    for (const category of snapshot.categories) {
      db.prepare(`
        INSERT INTO categories (id, name, icon, sort_order)
        VALUES (?, ?, ?, ?)
      `).run(category.id, category.name, category.icon, category.sortOrder);
    }

    for (const product of snapshot.products) {
      db.prepare(`
        INSERT INTO products (
          id, sku, barcode, name, category_id, subcategory, pack_size,
          unit_label, stock_on_hand, description, variants_json, last_vector_clock
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        product.id,
        product.sku,
        product.barcode ?? null,
        product.name,
        product.categoryId,
        product.subcategory,
        Math.max(1, Math.round(product.packSize || 1)),
        product.unitLabel,
        Math.max(0, Math.round(product.stockOnHand)),
        product.description ?? null,
        JSON.stringify(product.variants ?? []),
        stringifyJson({}),
      );

      for (const tier of product.priceTiers) {
        db.prepare(`
          INSERT INTO product_price_tiers (id, product_id, label, price, priority, min_qty, is_default)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          tier.id,
          product.id,
          tier.label,
          tier.price,
          tier.priority,
          tier.minQty ?? 0,
          tier.isDefault ? 1 : 0,
        );
      }
    }
  });

  transaction();
  rebuildProductSearchIndex(db);
}

function ensureDeviceState(db: Database.Database, deviceId: string, terminalId: string) {
  db.prepare(`
    INSERT INTO device_state (
      device_id, terminal_id, last_sequence_num, local_vector_clock,
      remote_vector_clock, confirmed_vector_clock, online
    )
    VALUES (?, ?, 0, '{}', '{}', '{}', 0)
    ON CONFLICT(device_id) DO UPDATE SET terminal_id = excluded.terminal_id
  `).run(deviceId, terminalId);
}

function getDeviceStateRow(db: Database.Database, deviceId: string, terminalId: string) {
  ensureDeviceState(db, deviceId, terminalId);
  return db.prepare('SELECT * FROM device_state WHERE device_id = ?').get(deviceId) as any;
}

function getUsers(db: Database.Database): POSUser[] {
  return (db.prepare('SELECT * FROM users ORDER BY code ASC').all() as any[]).map((row) =>
    sanitizeUser(mapUserRow(row)),
  );
}

function getUserMap(db: Database.Database): Map<string, POSUser> {
  return new Map(getUsers(db).map((user) => [user.id, user]));
}

export function loginLocalUser(input: POSAuthLoginInput): POSAuthResult {
  const db = getDB();
  const user = findUserByIdentifier(db, input.identifier);

  if (!user || (user.role !== 'CASHIER' && user.role !== 'MANAGER')) {
    throw new Error('Employee account was not recognised for this workstation.');
  }

  if (!user.pin || user.pin !== input.password.trim()) {
    throw new Error('Password does not match the selected employee.');
  }

  const token = createAuthToken();
  const timestamp = new Date().toISOString();

  db.prepare(`
    INSERT INTO auth_sessions (token, user_id, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `).run(token, user.id, timestamp, timestamp);

  return {
    token,
    user: sanitizeUser(user),
  };
}

export function getLocalAuthUser(token: string): POSUser | null {
  if (!token.trim()) {
    return null;
  }

  const db = getDB();
  const row = db.prepare(`
    SELECT u.*
    FROM auth_sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
    LIMIT 1
  `).get(token.trim()) as any;

  if (!row) {
    return null;
  }

  db.prepare(`
    UPDATE auth_sessions
    SET last_seen_at = ?
    WHERE token = ?
  `).run(new Date().toISOString(), token.trim());

  return sanitizeUser(mapUserRow(row));
}

export function clearLocalAuthSession(token: string): void {
  if (!token.trim()) {
    return;
  }

  getDB().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token.trim());
}

function getCustomers(db: Database.Database): Customer[] {
  return (db.prepare('SELECT * FROM customers ORDER BY name ASC').all() as any[]).map((row) => ({
    id: row.id,
    code: row.code ?? row.id,
    name: row.name,
    tier: row.tier,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
  }));
}

function getCategories(db: Database.Database): Category[] {
  return (db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all() as any[]).map((row) => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sort_order,
  }));
}

function getBranches(db: Database.Database): Branch[] {
  return (db.prepare('SELECT * FROM branches ORDER BY code ASC').all() as any[]).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
  }));
}

function getTerminals(db: Database.Database): Terminal[] {
  return (db.prepare('SELECT * FROM terminals ORDER BY code ASC').all() as any[]).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    branchId: row.branch_id,
    branchCode: SAMPLE_BRANCHES.find((branch) => branch.id === row.branch_id)?.code ?? '01',
  }));
}

function getPriceTiersByProduct(db: Database.Database): Map<string, ProductPriceTier[]> {
  const tiers = db.prepare(`
    SELECT * FROM product_price_tiers
    ORDER BY priority ASC, min_qty ASC, label ASC
  `).all() as any[];
  const grouped = new Map<string, ProductPriceTier[]>();
  for (const row of tiers) {
    const list = grouped.get(row.product_id) ?? [];
    list.push({
      id: row.id,
      label: row.label,
      price: row.price,
      priority: row.priority,
      minQty: row.min_qty ?? 0,
      isDefault: row.is_default === 1,
    });
    grouped.set(row.product_id, list);
  }
  return grouped;
}

function mapProductRow(row: any, tiersByProduct: Map<string, ProductPriceTier[]>): Product {
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode ?? undefined,
    name: row.name,
    categoryId: row.category_id,
    subcategory: row.subcategory,
    packSize: row.pack_size,
    unitLabel: row.unit_label,
    stockOnHand: row.stock_on_hand,
    description: row.description ?? undefined,
    variants: parseProductVariants(row.variants_json ?? row.variantsJson),
    priceTiers: tiersByProduct.get(row.id) ?? [],
  };
}

function getProducts(db: Database.Database): Product[] {
  const tiersByProduct = getPriceTiersByProduct(db);
  const rows = db.prepare('SELECT * FROM products ORDER BY sku ASC').all() as any[];
  return rows.map((row) => mapProductRow(row, tiersByProduct));
}

function getAvailableLineStock(db: Database.Database, line: Pick<CartLine, 'productId' | 'variantId'>): number {
  const row = db.prepare('SELECT stock_on_hand, variants_json FROM products WHERE id = ?').get(line.productId) as any;
  if (!row) {
    return 0;
  }

  if (!line.variantId) {
    return Number(row.stock_on_hand ?? 0);
  }

  const variant = parseProductVariants(row.variants_json).find((entry) => entry.id === line.variantId);
  return Number(variant?.stockOnHand ?? 0);
}

function updateProductStockRow(
  db: Database.Database,
  input: {
    productId: string;
    variantId?: string | null;
    delta: number;
    vectorClock: VectorClock;
  },
): void {
  const row = db.prepare('SELECT variants_json FROM products WHERE id = ?').get(input.productId) as any;
  const nextVariantsJson = input.variantId
    ? stringifyJson(
        applyVariantStockDelta(
          parseProductVariants(row?.variants_json),
          input.variantId,
          input.delta,
        ),
      )
    : row?.variants_json ?? null;

  db.prepare(`
    UPDATE products
    SET stock_on_hand = stock_on_hand + ?, variants_json = ?, last_vector_clock = ?
    WHERE id = ?
  `).run(input.delta, nextVariantsJson, stringifyJson(input.vectorClock), input.productId);
}

function getAggregateClock(db: Database.Database, aggregateType: string, aggregateId: string): VectorClock {
  switch (aggregateType) {
    case 'shift': {
      const row = db.prepare('SELECT last_vector_clock FROM shifts WHERE id = ?').get(aggregateId) as any;
      return normalizeClock(row?.last_vector_clock);
    }
    case 'sale': {
      const row = db.prepare('SELECT last_vector_clock FROM sales WHERE id = ?').get(aggregateId) as any;
      return normalizeClock(row?.last_vector_clock);
    }
    case 'held-sale': {
      const row = db.prepare('SELECT last_vector_clock FROM held_sales WHERE id = ?').get(aggregateId) as any;
      return normalizeClock(row?.last_vector_clock);
    }
    case 'return': {
      const row = db.prepare('SELECT last_vector_clock FROM returns WHERE id = ?').get(aggregateId) as any;
      return normalizeClock(row?.last_vector_clock);
    }
    default:
      return {};
  }
}

function mapSyncEventRow(row: any): SyncEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    deviceId: row.device_id,
    sequenceNum: row.sequence_num,
    lamport: row.lamport,
    vectorClock: normalizeClock(row.vector_clock_json),
    conflictPolicy: row.conflict_policy,
    state: row.state,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
  };
}

function mapSyncConflictRow(row: any): SyncConflict {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    localEventId: row.local_event_id ?? undefined,
    remoteEventId: row.remote_event_id ?? undefined,
    policy: row.policy,
    status: row.status,
    detail: parseJson<Record<string, unknown> | undefined>(row.detail_json, undefined),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

function getLatestAggregateEvent(db: Database.Database, aggregateType: string, aggregateId: string): SyncEvent | null {
  const rows = db.prepare(`
    SELECT * FROM sync_event_log
    WHERE aggregate_type = ? AND aggregate_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(aggregateType, aggregateId) as any[];

  if (rows.length === 0) {
    return null;
  }

  return rows
    .map(mapSyncEventRow)
    .sort((left, right) =>
      compareEventOrder(right.sequenceNum, right.deviceId, left.sequenceNum, left.deviceId),
    )[0] ?? null;
}

function recordConflict(db: Database.Database, incoming: SyncEvent, existing: SyncEvent): SyncConflict {
  const conflict: SyncConflict = {
    id: uuidv4(),
    aggregateType: incoming.aggregateType,
    aggregateId: incoming.aggregateId,
    localEventId: existing.id,
    remoteEventId: incoming.id,
    policy: incoming.conflictPolicy,
    status: SyncConflictStatus.OPEN,
    detail: {
      localVectorClock: existing.vectorClock,
      remoteVectorClock: incoming.vectorClock,
    },
    createdAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO sync_conflicts (
      id, aggregate_type, aggregate_id, local_event_id, remote_event_id,
      policy, status, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conflict.id,
    conflict.aggregateType,
    conflict.aggregateId,
    conflict.localEventId ?? null,
    conflict.remoteEventId ?? null,
    conflict.policy,
    conflict.status,
    stringifyJson(conflict.detail),
    conflict.createdAt,
  );

  return conflict;
}

function persistEvent(db: Database.Database, event: SyncEvent, source: 'LOCAL' | 'REMOTE', applied: boolean): void {
  db.prepare(`
    INSERT INTO sync_event_log (
      id, aggregate_type, aggregate_id, event_type, payload_json, device_id,
      terminal_id, sequence_num, lamport, vector_clock_json, conflict_policy,
      state, source, created_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.aggregateType,
    event.aggregateId,
    event.eventType,
    stringifyJson(event.payload),
    event.deviceId,
    (event.payload as any).terminalId ?? null,
    event.sequenceNum,
    event.lamport,
    stringifyJson(event.vectorClock),
    event.conflictPolicy,
    event.state,
    source,
    event.createdAt,
    applied ? (event.appliedAt ?? new Date().toISOString()) : null,
  );
}

function updateDeviceStateAfterEvent(
  db: Database.Database,
  deviceId: string,
  terminalId: string,
  nextSequence: number,
  localClock: VectorClock,
  remoteClock?: VectorClock,
): void {
  ensureDeviceState(db, deviceId, terminalId);
  db.prepare(`
    UPDATE device_state
    SET last_sequence_num = ?, terminal_id = ?, local_vector_clock = ?, remote_vector_clock = ?
    WHERE device_id = ?
  `).run(
    nextSequence,
    terminalId,
    stringifyJson(localClock),
    stringifyJson(remoteClock ?? normalizeClock((db.prepare('SELECT remote_vector_clock FROM device_state WHERE device_id = ?').get(deviceId) as any)?.remote_vector_clock)),
    deviceId,
  );
}

function saveCashCountRow(
  db: Database.Database,
  shiftId: string,
  declaration: ShiftOpenInput['declaration'] | ShiftCloseInput['declaration'] | undefined,
  idPrefix: string,
): void {
  if (!declaration) {
    return;
  }

  const hasTenders = declaration.tenderMode != null
    && Object.keys(declaration.tenders ?? {}).length > 0;

  db.prepare(`
    INSERT INTO shift_cash_counts (
      id, shift_id, mode, total, denominations_json, variance, tenders_json, tender_mode, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      total = excluded.total,
      denominations_json = excluded.denominations_json,
      variance = excluded.variance,
      tenders_json = excluded.tenders_json,
      tender_mode = excluded.tender_mode
  `).run(
    `${idPrefix}-${declaration.mode}`,
    shiftId,
    declaration.mode,
    declaration.total,
    stringifyJson(declaration.denominations),
    declaration.variance ?? null,
    hasTenders ? stringifyJson(declaration.tenders) : null,
    hasTenders ? declaration.tenderMode : null,
    new Date().toISOString(),
  );
}

function applyShiftOpened(db: Database.Database, event: SyncEvent<ShiftOpenInput>): void {
  const payload = event.payload;
  db.prepare(`
    INSERT INTO shifts (
      id, terminal_id, branch_id, cashier_id, status, opening_float,
      notes, last_vector_clock, opened_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      terminal_id = excluded.terminal_id,
      branch_id = excluded.branch_id,
      cashier_id = excluded.cashier_id,
      status = excluded.status,
      opening_float = excluded.opening_float,
      notes = excluded.notes,
      last_vector_clock = excluded.last_vector_clock
  `).run(
    event.aggregateId,
    payload.terminalId,
    payload.branchId,
    payload.cashierId,
    ShiftStatus.OPEN,
    payload.openingFloat,
    payload.notes ?? null,
    stringifyJson(event.vectorClock),
    new Date().toISOString(),
  );

  saveCashCountRow(db, event.aggregateId, payload.declaration, `${event.aggregateId}-opening`);
}

function applyShiftClosed(db: Database.Database, event: SyncEvent<ShiftCloseInput>): void {
  const payload = event.payload;
  db.prepare(`
    UPDATE shifts
    SET status = ?, closing_float = ?, notes = ?, closed_at = ?, last_vector_clock = ?
    WHERE id = ?
  `).run(
    ShiftStatus.CLOSED,
    payload.closingFloat,
    payload.notes ?? null,
    new Date().toISOString(),
    stringifyJson(event.vectorClock),
    payload.shiftId,
  );

  saveCashCountRow(db, payload.shiftId, payload.declaration, `${payload.shiftId}-closing`);
}

function replaceHeldSaleLines(db: Database.Database, heldSaleId: string, lines: CartLine[]): void {
  db.prepare('DELETE FROM held_sale_lines WHERE held_sale_id = ?').run(heldSaleId);
  for (const line of lines) {
    db.prepare(`
      INSERT INTO held_sale_lines (
        id, held_sale_id, product_id, sku, name, variant_id, variant_code,
        variant_name, variant_attributes_json, subcategory, quantity,
        unit_price, tier_label, discount_percent, discount_amount,
        salesperson_id, cost_basis, line_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      line.uid,
      heldSaleId,
      line.productId,
      line.sku,
      line.name,
      line.variantId ?? null,
      line.variantCode ?? null,
      line.variantName ?? null,
      line.variantAttributes ? stringifyJson(line.variantAttributes) : null,
      line.subcategory,
      line.quantity,
      line.unitPrice,
      line.tierLabel,
      line.discountPercent,
      line.discountAmount,
      line.salespersonId,
      line.costBasis,
      line.lineTotal,
    );
  }
}

function applyHeldSaleSaved(db: Database.Database, event: SyncEvent<HoldSaleInput>): void {
  const payload = event.payload;
  const customer = payload.customerId
    ? db.prepare('SELECT name FROM customers WHERE id = ?').get(payload.customerId) as any
    : null;

  db.prepare(`
    INSERT INTO held_sales (
      id, hold_number, terminal_id, branch_id, cashier_id, customer_id,
      customer_name, status, subtotal, discount_total, total, notes,
      last_vector_clock, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      hold_number = excluded.hold_number,
      terminal_id = excluded.terminal_id,
      branch_id = excluded.branch_id,
      cashier_id = excluded.cashier_id,
      customer_id = excluded.customer_id,
      customer_name = excluded.customer_name,
      status = excluded.status,
      subtotal = excluded.subtotal,
      discount_total = excluded.discount_total,
      total = excluded.total,
      notes = excluded.notes,
      last_vector_clock = excluded.last_vector_clock,
      updated_at = excluded.updated_at
  `).run(
    event.aggregateId,
    payload.holdNumber,
    payload.terminalId,
    payload.branchId,
    payload.cashierId,
    payload.customerId ?? null,
    customer?.name ?? null,
    SaleStatus.HELD,
    payload.subtotal,
    payload.discountTotal,
    payload.total,
    null,
    stringifyJson(event.vectorClock),
    new Date().toISOString(),
    new Date().toISOString(),
  );

  replaceHeldSaleLines(db, event.aggregateId, payload.lines);
}

function applyHeldSaleRecalled(db: Database.Database, event: SyncEvent<{ heldSaleId: string }>): void {
  db.prepare(`
    UPDATE held_sales
    SET status = ?, last_vector_clock = ?, updated_at = ?
    WHERE id = ?
  `).run(
    SaleStatus.RECALLED,
    stringifyJson(event.vectorClock),
    new Date().toISOString(),
    event.payload.heldSaleId,
  );
}

function replaceSaleLines(db: Database.Database, saleId: string, lines: CartLine[]): void {
  for (const line of lines) {
    const marginAmount = line.quantity * (line.unitPrice - line.costBasis) - line.discountAmount;
    db.prepare(`
      INSERT INTO sale_lines (
        id, sale_id, product_id, sku, name, barcode, variant_id, variant_code,
        variant_name, variant_attributes_json, subcategory, quantity,
        unit_price, tier_label, discount_percent, discount_amount,
        salesperson_id, cost_basis, margin_amount, line_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      line.uid,
      saleId,
      line.productId,
      line.sku,
      line.name,
      line.barcode ?? null,
      line.variantId ?? null,
      line.variantCode ?? null,
      line.variantName ?? null,
      line.variantAttributes ? stringifyJson(line.variantAttributes) : null,
      line.subcategory,
      line.quantity,
      line.unitPrice,
      line.tierLabel,
      line.discountPercent,
      line.discountAmount,
      line.salespersonId,
      line.costBasis,
      marginAmount,
      line.lineTotal,
    );
  }
}

function replacePayments(db: Database.Database, saleId: string, payments: PaymentInput[]): void {
  for (const payment of payments) {
    db.prepare(`
      INSERT INTO payments (
        id, sale_id, method, amount, tendered_amount, change_due, reference, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      saleId,
      payment.method,
      payment.amount,
      payment.tenderedAmount ?? null,
      payment.changeDue ?? null,
      payment.reference ?? null,
      payment.metadata ? stringifyJson(payment.metadata) : null,
    );
  }
}

function assertSufficientStock(db: Database.Database, lines: CartLine[]): void {
  for (const line of lines) {
    const available = getAvailableLineStock(db, line);
    if (available < line.quantity) {
      throw new Error(`Insufficient local stock for ${line.sku}`);
    }
  }
}

function applySaleCompleted(db: Database.Database, event: SyncEvent<CompleteSaleInput>): void {
  const payload = event.payload;
  const existing = db.prepare('SELECT id FROM sales WHERE id = ?').get(event.aggregateId) as any;
  if (existing) {
    return;
  }

  for (const line of payload.lines) {
    updateProductStockRow(db, {
      productId: line.productId,
      variantId: line.variantId,
      delta: -line.quantity,
      vectorClock: event.vectorClock,
    });
  }

  db.prepare(`
    INSERT INTO sales (
      id, receipt_number, terminal_id, branch_id, cashier_id, customer_id,
      shift_id, held_sale_id, status, subtotal, discount_total, tax_total,
      total, margin_total, source_device_id, source_sequence_num,
      last_vector_clock, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.aggregateId,
    payload.receiptNumber,
    payload.terminalId,
    payload.branchId ?? null,
    payload.cashierId,
    payload.customerId ?? null,
    payload.shiftId ?? null,
    payload.heldSaleId ?? null,
    SaleStatus.COMPLETED,
    payload.subtotal,
    payload.discountTotal,
    payload.taxTotal,
    payload.total,
    payload.marginTotal,
    event.deviceId,
    event.sequenceNum,
    stringifyJson(event.vectorClock),
    new Date().toISOString(),
    new Date().toISOString(),
  );

  replaceSaleLines(db, event.aggregateId, payload.lines);
  replacePayments(db, event.aggregateId, payload.payments);

  if (payload.heldSaleId) {
    db.prepare(`
      UPDATE held_sales
      SET status = ?, last_vector_clock = ?, updated_at = ?
      WHERE id = ?
    `).run(
      SaleStatus.RECALLED,
      stringifyJson(event.vectorClock),
      new Date().toISOString(),
      payload.heldSaleId,
    );
  }
}

function applySaleVoided(db: Database.Database, event: SyncEvent<{ saleId: string; reason?: string; managerId?: string }>): void {
  const sale = db.prepare('SELECT id, status, receipt_number FROM sales WHERE id = ?').get(event.payload.saleId) as any;
  if (!sale || sale.status === SaleStatus.VOIDED) {
    return;
  }

  const lines = db.prepare('SELECT product_id, variant_id, quantity FROM sale_lines WHERE sale_id = ?').all(event.payload.saleId) as any[];
  for (const line of lines) {
    updateProductStockRow(db, {
      productId: line.product_id,
      variantId: line.variant_id,
      delta: line.quantity,
      vectorClock: event.vectorClock,
    });
  }

  db.prepare(`
    UPDATE sales
    SET status = ?, last_vector_clock = ?, updated_at = ?
    WHERE id = ?
  `).run(
    SaleStatus.VOIDED,
    stringifyJson(event.vectorClock),
    new Date().toISOString(),
    event.payload.saleId,
  );
}

function applyReturnCreated(db: Database.Database, event: SyncEvent<ReturnInput>): void {
  const payload = event.payload;
  const existing = db.prepare('SELECT id FROM returns WHERE id = ?').get(event.aggregateId) as any;
  if (existing) {
    return;
  }

  const totalRefund = payload.lines.reduce((sum, line) => sum + line.refundAmount, 0);
  db.prepare(`
    INSERT INTO returns (
      id, sale_id, terminal_id, cashier_id, reason, total_refund,
      source_device_id, source_sequence_num, last_vector_clock, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.aggregateId,
    payload.saleId,
    payload.terminalId,
    payload.cashierId,
    payload.reason ?? null,
    totalRefund,
    event.deviceId,
    event.sequenceNum,
    stringifyJson(event.vectorClock),
    new Date().toISOString(),
  );

  for (const line of payload.lines) {
    db.prepare(`
      INSERT INTO return_lines (id, return_id, sale_line_id, product_id, variant_id, quantity, refund_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      event.aggregateId,
      line.saleLineId,
      line.productId,
      line.variantId ?? null,
      line.quantity,
      line.refundAmount,
    );

    updateProductStockRow(db, {
      productId: line.productId,
      variantId: line.variantId,
      delta: line.quantity,
      vectorClock: event.vectorClock,
    });
  }

  db.prepare(`
    UPDATE sales
    SET status = ?, last_vector_clock = ?, updated_at = ?
    WHERE id = ?
  `).run(
    SaleStatus.REFUNDED,
    stringifyJson(event.vectorClock),
    new Date().toISOString(),
    payload.saleId,
  );
}

function applyProjectionEvent(db: Database.Database, event: SyncEvent): void {
  switch (event.eventType) {
    case SyncEventType.SHIFT_OPENED:
      applyShiftOpened(db, event as SyncEvent<ShiftOpenInput>);
      return;
    case SyncEventType.SHIFT_CLOSED:
      applyShiftClosed(db, event as SyncEvent<ShiftCloseInput>);
      return;
    case SyncEventType.HELD_SALE_SAVED:
      applyHeldSaleSaved(db, event as SyncEvent<HoldSaleInput>);
      return;
    case SyncEventType.HELD_SALE_RECALLED:
      applyHeldSaleRecalled(db, event as SyncEvent<{ heldSaleId: string }>);
      return;
    case SyncEventType.SALE_COMPLETED:
      applySaleCompleted(db, event as SyncEvent<CompleteSaleInput>);
      return;
    case SyncEventType.SALE_VOIDED:
      applySaleVoided(db, event as SyncEvent<{ saleId: string; reason?: string; managerId?: string }>);
      return;
    case SyncEventType.RETURN_CREATED:
      applyReturnCreated(db, event as SyncEvent<ReturnInput>);
      return;
    case SyncEventType.CASH_DECLARED:
      saveCashCountRow(
        db,
        (event.payload as any).shiftId,
        (event.payload as any).declaration,
        `${(event.payload as any).shiftId}-${event.id}`,
      );
      return;
    default:
      return;
  }
}

function appendEventToLog(
  db: Database.Database,
  event: SyncEvent,
  source: 'LOCAL' | 'REMOTE',
  terminalId: string,
): { applied: boolean; conflict?: SyncConflict } {
  const duplicate = db.prepare(`
    SELECT * FROM sync_event_log
    WHERE id = ? OR (device_id = ? AND sequence_num = ?)
    LIMIT 1
  `).get(event.id, event.deviceId, event.sequenceNum) as any;
  if (duplicate) {
    return { applied: duplicate.applied_at != null };
  }

  const aggregateClock = getAggregateClock(db, event.aggregateType, event.aggregateId);
  const relation = compareVectorClocks(event.vectorClock, aggregateClock);
  const latestEvent = getLatestAggregateEvent(db, event.aggregateType, event.aggregateId);

  let apply = relation !== 'lt' && relation !== 'equal';
  let conflict: SyncConflict | undefined;
  if (relation === 'concurrent' && latestEvent) {
    conflict = recordConflict(db, event, latestEvent);
    apply = eventWins(event, latestEvent);
  }

  persistEvent(db, { ...event, appliedAt: apply ? new Date().toISOString() : undefined }, source, apply);
  if (apply) {
    applyProjectionEvent(db, event);
  }

  const stateRow = getDeviceStateRow(db, DEFAULT_DEVICE_ID, terminalId);
  const mergedLocalClock = mergeClocks(normalizeClock(stateRow.local_vector_clock), event.vectorClock);
  const mergedRemoteClock = source === 'REMOTE'
    ? mergeClocks(normalizeClock(stateRow.remote_vector_clock), event.vectorClock)
    : normalizeClock(stateRow.remote_vector_clock);

  updateDeviceStateAfterEvent(
    db,
    DEFAULT_DEVICE_ID,
    terminalId,
    stateRow.last_sequence_num,
    mergedLocalClock,
    mergedRemoteClock,
  );

  return { applied: apply, conflict };
}

function createLocalEventEnvelope(
  db: Database.Database,
  terminalId: string,
  input: {
    aggregateType: string;
    aggregateId: string;
    eventType: SyncEventType;
    payload: unknown;
    deviceId?: string;
  },
): SyncEvent {
  const deviceId = input.deviceId ?? DEFAULT_DEVICE_ID;
  const state = getDeviceStateRow(db, deviceId, terminalId);
  const currentClock = normalizeClock(state.local_vector_clock);
  const nextSequence = (state.last_sequence_num ?? 0) + 1;
  const vectorClock = { ...currentClock, [deviceId]: nextSequence };

  db.prepare(`
    UPDATE device_state
    SET last_sequence_num = ?, local_vector_clock = ?, terminal_id = ?
    WHERE device_id = ?
  `).run(nextSequence, stringifyJson(vectorClock), terminalId, deviceId);

  return {
    id: uuidv4(),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: input.payload,
    deviceId,
    sequenceNum: nextSequence,
    lamport: nextSequence,
    vectorClock,
    conflictPolicy: resolveConflictPolicy(input.eventType),
    state: SyncEventState.PENDING,
    createdAt: new Date().toISOString(),
  };
}

function createAndApplyLocalEvent(
  db: Database.Database,
  terminalId: string,
  input: {
    aggregateType: string;
    aggregateId: string;
    eventType: SyncEventType;
    payload: unknown;
  },
): SyncEvent {
  const event = createLocalEventEnvelope(db, terminalId, input);
  appendEventToLog(db, event, 'LOCAL', terminalId);
  return event;
}

function mapShiftRow(row: any, userMap: Map<string, POSUser>): ShiftSummary {
  return {
    id: row.id,
    terminalId: row.terminal_id,
    branchId: row.branch_id ?? 'branch-jingles-01',
    cashierId: row.cashier_id,
    cashierName: userMap.get(row.cashier_id)?.name ?? row.cashier_id,
    status: row.status,
    openingFloat: row.opening_float,
    closingFloat: row.closing_float ?? undefined,
    openedAt: row.opened_at,
    closedAt: row.closed_at ?? undefined,
    notes: row.notes ?? undefined,
  };
}

function mapHeldSaleRows(db: Database.Database, userMap: Map<string, POSUser>): HeldSaleSummary[] {
  const lineRows = db.prepare('SELECT * FROM held_sale_lines').all() as any[];
  const groupedLines = new Map<string, any[]>();
  for (const row of lineRows) {
    const list = groupedLines.get(row.held_sale_id) ?? [];
    list.push(row);
    groupedLines.set(row.held_sale_id, list);
  }

  const heldRows = db.prepare(`
    SELECT * FROM held_sales
    WHERE status = ?
    ORDER BY created_at DESC
  `).all(SaleStatus.HELD) as any[];

  return heldRows.map((row) => {
    const lines = groupedLines.get(row.id) ?? [];
    return {
      id: row.id,
      holdNumber: row.hold_number,
      terminalId: row.terminal_id,
      branchId: row.branch_id,
      cashierId: row.cashier_id,
      cashierName: userMap.get(row.cashier_id)?.name ?? row.cashier_id,
      customerId: row.customer_id ?? undefined,
      customerName: row.customer_name ?? undefined,
      status: row.status,
      subtotal: row.subtotal,
      discountTotal: row.discount_total,
      total: row.total,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lines: lines.map((line) => ({
        id: line.id,
        heldSaleId: line.held_sale_id,
        productId: line.product_id,
        sku: line.sku,
        name: line.name,
        variantId: line.variant_id ?? undefined,
        variantCode: line.variant_code ?? undefined,
        variantName: line.variant_name ?? undefined,
        variantAttributes: parseJson(line.variant_attributes_json, undefined),
        subcategory: line.subcategory,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        tierLabel: line.tier_label,
        discountPercent: line.discount_percent,
        discountAmount: line.discount_amount,
        salespersonId: line.salesperson_id ?? '',
        salespersonName: userMap.get(line.salesperson_id)?.name ?? 'Unassigned',
        salespersonInitials: userMap.get(line.salesperson_id)?.initials ?? '--',
        costBasis: line.cost_basis,
        lineTotal: line.line_total,
      })),
    };
  });
}

function mapSales(db: Database.Database, userMap: Map<string, POSUser>): SaleSummary[] {
  const lineRows = db.prepare('SELECT * FROM sale_lines').all() as any[];
  const paymentRows = db.prepare('SELECT * FROM payments').all() as any[];
  const groupedLines = new Map<string, any[]>();
  const groupedPayments = new Map<string, any[]>();

  for (const row of lineRows) {
    const list = groupedLines.get(row.sale_id) ?? [];
    list.push(row);
    groupedLines.set(row.sale_id, list);
  }
  for (const row of paymentRows) {
    const list = groupedPayments.get(row.sale_id) ?? [];
    list.push(row);
    groupedPayments.set(row.sale_id, list);
  }

  const rows = db.prepare('SELECT * FROM sales ORDER BY created_at DESC').all() as any[];
  return rows.map((row) => ({
    id: row.id,
    receiptNumber: row.receipt_number,
    terminalId: row.terminal_id,
    branchId: row.branch_id ?? 'branch-jingles-01',
    cashierId: row.cashier_id,
    cashierName: userMap.get(row.cashier_id)?.name ?? row.cashier_id,
    customerId: row.customer_id ?? undefined,
    customerName: row.customer_id
      ? (db.prepare('SELECT name FROM customers WHERE id = ?').get(row.customer_id) as any)?.name
      : undefined,
    shiftId: row.shift_id ?? undefined,
    status: row.status,
    subtotal: row.subtotal,
    discountTotal: row.discount_total,
    taxTotal: row.tax_total,
    total: row.total,
    marginTotal: row.margin_total,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines: (groupedLines.get(row.id) ?? []).map((line) => ({
      id: line.id,
      saleId: line.sale_id,
      productId: line.product_id,
      sku: line.sku,
      name: line.name,
      variantId: line.variant_id ?? undefined,
      variantCode: line.variant_code ?? undefined,
      variantName: line.variant_name ?? undefined,
      variantAttributes: parseJson(line.variant_attributes_json, undefined),
      subcategory: line.subcategory,
      quantity: line.quantity,
      unitPrice: line.unit_price,
      tierLabel: line.tier_label,
      discountPercent: line.discount_percent,
      discountAmount: line.discount_amount,
      salespersonId: line.salesperson_id ?? '',
      salespersonName: userMap.get(line.salesperson_id)?.name ?? 'Unassigned',
      salespersonInitials: userMap.get(line.salesperson_id)?.initials ?? '--',
      costBasis: line.cost_basis,
      marginAmount: line.margin_amount,
      lineTotal: line.line_total,
    })),
    payments: (groupedPayments.get(row.id) ?? []).map((payment) => ({
      method: payment.method,
      amount: payment.amount,
      tenderedAmount: payment.tendered_amount ?? undefined,
      changeDue: payment.change_due ?? undefined,
      reference: payment.reference ?? undefined,
      metadata: parseJson<Record<string, unknown> | undefined>(payment.metadata_json, undefined),
    })),
  }));
}

function getSyncStatusInternal(db: Database.Database, deviceId: string, terminalId: string): SyncStatusSummary {
  const state = getDeviceStateRow(db, deviceId, terminalId);
  const pendingEvents = (db.prepare(`
    SELECT COUNT(*) AS count FROM sync_event_log WHERE state = ?
  `).get(SyncEventState.PENDING) as any).count;
  const conflictCount = (db.prepare(`
    SELECT COUNT(*) AS count FROM sync_conflicts WHERE status = ?
  `).get(SyncConflictStatus.OPEN) as any).count;

  return {
    online: state.online === 1,
    pendingEvents,
    conflictCount,
    deviceId,
    localVectorClock: normalizeClock(state.local_vector_clock),
    remoteVectorClock: normalizeClock(state.remote_vector_clock),
    lastSyncAt: state.last_sync_at ?? undefined,
    lastError: state.last_error ?? undefined,
  };
}

export function bootstrapPOS(options?: { deviceId?: string; terminalId?: string }): POSBootstrap {
  const db = getDB();
  const deviceId = options?.deviceId ?? DEFAULT_DEVICE_ID;
  const terminalId = options?.terminalId ?? DEFAULT_TERMINAL_ID;
  ensureDeviceState(db, deviceId, terminalId);
  const userMap = getUserMap(db);

  const activeShiftRow = db.prepare(`
    SELECT * FROM shifts
    WHERE terminal_id = ? AND status = ?
    ORDER BY opened_at DESC
    LIMIT 1
  `).get(terminalId, ShiftStatus.OPEN) as any;

  return {
    branches: getBranches(db),
    terminals: getTerminals(db),
    users: getUsers(db),
    customers: getCustomers(db),
    categories: getCategories(db),
    products: getProducts(db),
    activeShift: activeShiftRow ? mapShiftRow(activeShiftRow, userMap) : null,
    heldSales: mapHeldSaleRows(db, userMap),
    syncStatus: getSyncStatusInternal(db, deviceId, terminalId),
  };
}

export function searchLocalProducts(query: string): Product[] {
  const db = getDB();
  const tiersByProduct = getPriceTiersByProduct(db);
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    const rows = db.prepare(`
      SELECT *
      FROM products
      ORDER BY sku ASC
      LIMIT 30
    `).all() as any[];
    return rows.map((row) => mapProductRow(row, tiersByProduct));
  }

  const exactBarcodeRows = db.prepare(`
    SELECT *
    FROM products
    WHERE barcode = ?
    ORDER BY sku ASC
    LIMIT 5
  `).all(trimmedQuery) as any[];

  try {
    const ftsQuery = buildFtsQuery(trimmedQuery);
    if (ftsQuery) {
      const rows = db.prepare(`
        SELECT p.*
        FROM products_fts
        INNER JOIN products p ON p.id = products_fts.id
        WHERE products_fts MATCH ?
          AND p.id NOT IN (
            SELECT id FROM products WHERE barcode = ?
          )
        ORDER BY bm25(products_fts), p.sku ASC
        LIMIT 30
      `).all(ftsQuery, trimmedQuery) as any[];

      return [...exactBarcodeRows, ...rows]
        .slice(0, 30)
        .map((row) => mapProductRow(row, tiersByProduct));
    }
  } catch {
    // Fall through to the basic contains filter if the FTS table is unavailable.
  }

  const rows = db.prepare(`
    SELECT *
    FROM products
    WHERE sku LIKE ? OR name LIKE ? OR barcode = ? OR subcategory LIKE ?
    ORDER BY sku ASC
    LIMIT 30
  `).all(`%${trimmedQuery}%`, `%${trimmedQuery}%`, trimmedQuery, `%${trimmedQuery}%`) as any[];

  return rows.map((row) => mapProductRow(row, tiersByProduct));
}

export function getActiveLocalShift(terminalId: string): ShiftSummary | undefined {
  const db = getDB();
  const row = db.prepare(`
    SELECT * FROM shifts
    WHERE terminal_id = ? AND status = ?
    ORDER BY opened_at DESC
    LIMIT 1
  `).get(terminalId, ShiftStatus.OPEN) as any;
  if (!row) {
    return undefined;
  }
  return mapShiftRow(row, getUserMap(db));
}

export function openLocalShift(input: ShiftOpenInput): ShiftSummary {
  const db = getDB();
  const existing = getActiveLocalShift(input.terminalId);
  if (existing) {
    return existing;
  }

  const shiftId = uuidv4();
  const transaction = db.transaction(() => {
    createAndApplyLocalEvent(db, input.terminalId, {
      aggregateType: 'shift',
      aggregateId: shiftId,
      eventType: SyncEventType.SHIFT_OPENED,
      payload: {
        shiftId,
        terminalId: input.terminalId,
        branchId: input.branchId,
        cashierId: input.cashierId,
        openingFloat: input.openingFloat,
        notes: input.notes,
        declaration: input.declaration,
      },
    });
  });
  transaction();

  return getActiveLocalShift(input.terminalId)!;
}

export function closeLocalShift(input: ShiftCloseInput & { terminalId?: string }): ShiftSummary {
  const db = getDB();
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(input.shiftId) as any;
  if (!shift) {
    throw new Error('Shift not found');
  }

  const transaction = db.transaction(() => {
    createAndApplyLocalEvent(db, input.terminalId ?? shift.terminal_id, {
      aggregateType: 'shift',
      aggregateId: input.shiftId,
      eventType: SyncEventType.SHIFT_CLOSED,
      payload: {
        shiftId: input.shiftId,
        closingFloat: input.closingFloat,
        notes: input.notes,
        declaration: input.declaration,
      },
    });
  });
  transaction();

  const updated = db.prepare('SELECT * FROM shifts WHERE id = ?').get(input.shiftId) as any;
  return mapShiftRow(updated, getUserMap(db));
}

export function saveHeldSale(input: Omit<HoldSaleInput, 'holdNumber'> & { holdNumber?: string }): HeldSaleSummary {
  const db = getDB();
  const holdSaleId = uuidv4();
  const holdNumber = input.holdNumber ?? `H-${Date.now()}`;
  const transaction = db.transaction(() => {
    createAndApplyLocalEvent(db, input.terminalId, {
      aggregateType: 'held-sale',
      aggregateId: holdSaleId,
      eventType: SyncEventType.HELD_SALE_SAVED,
      payload: {
        holdNumber,
        terminalId: input.terminalId,
        branchId: input.branchId,
        cashierId: input.cashierId,
        customerId: input.customerId,
        lines: input.lines,
        discountTotal: input.discountTotal,
        subtotal: input.subtotal,
        total: input.total,
      },
    });
  });
  transaction();

  return mapHeldSaleRows(db, getUserMap(db)).find((sale) => sale.id === holdSaleId)!;
}

export function listHeldSales(): HeldSaleSummary[] {
  const db = getDB();
  return mapHeldSaleRows(db, getUserMap(db));
}

export function recallHeldSale(heldSaleId: string, terminalId: string = DEFAULT_TERMINAL_ID): HeldSaleSummary | undefined {
  const db = getDB();
  const heldSale = mapHeldSaleRows(db, getUserMap(db)).find((row) => row.id === heldSaleId);
  if (!heldSale) {
    return undefined;
  }

  const transaction = db.transaction(() => {
    createAndApplyLocalEvent(db, terminalId, {
      aggregateType: 'held-sale',
      aggregateId: heldSaleId,
      eventType: SyncEventType.HELD_SALE_RECALLED,
      payload: {
        heldSaleId,
      },
    });
  });
  transaction();

  return heldSale;
}

export function createLocalSale(input: CompleteSaleInput): SaleSummary {
  const db = getDB();
  assertSufficientStock(db, input.lines);
  const saleId = uuidv4();
  const transaction = db.transaction(() => {
    createAndApplyLocalEvent(db, input.terminalId, {
      aggregateType: 'sale',
      aggregateId: saleId,
      eventType: SyncEventType.SALE_COMPLETED,
      payload: input,
    });
  });
  transaction();

  return listLocalSales().find((sale) => sale.id === saleId)!;
}

export function listLocalSales(): SaleSummary[] {
  const db = getDB();
  return mapSales(db, getUserMap(db));
}

export function getLocalSale(id: string): SaleSummary | undefined {
  return listLocalSales().find((sale) => sale.id === id);
}

export function createLocalReturn(input: ReturnInput): { id: string; saleId: string; totalRefund: number } {
  const db = getDB();
  const returnId = uuidv4();
  const totalRefund = input.lines.reduce((sum, line) => sum + line.refundAmount, 0);
  const transaction = db.transaction(() => {
    createAndApplyLocalEvent(db, input.terminalId, {
      aggregateType: 'return',
      aggregateId: returnId,
      eventType: SyncEventType.RETURN_CREATED,
      payload: input,
    });
  });
  transaction();

  return {
    id: returnId,
    saleId: input.saleId,
    totalRefund,
  };
}

export function getPendingSyncEvents(): SyncEvent[] {
  const db = getDB();
  return (db.prepare(`
    SELECT * FROM sync_event_log
    WHERE state = ?
    ORDER BY created_at ASC
  `).all(SyncEventState.PENDING) as any[]).map(mapSyncEventRow);
}

export function listRecentSyncEvents(limit = 20): SyncEvent[] {
  const db = getDB();
  return (db.prepare(`
    SELECT *
    FROM sync_event_log
    ORDER BY datetime(created_at) DESC, sequence_num DESC
    LIMIT ?
  `).all(limit) as any[]).map(mapSyncEventRow);
}

export function listSyncConflicts(limit = 20): SyncConflict[] {
  const db = getDB();
  return (db.prepare(`
    SELECT *
    FROM sync_conflicts
    ORDER BY datetime(created_at) DESC
    LIMIT ?
  `).all(limit) as any[]).map(mapSyncConflictRow);
}

export function getSyncDashboard(
  deviceId: string = DEFAULT_DEVICE_ID,
  terminalId: string = DEFAULT_TERMINAL_ID,
  limit = 20,
): POSSyncDashboard {
  return {
    status: getSyncStatus(deviceId, terminalId),
    pendingEvents: getPendingSyncEvents().slice(0, limit),
    recentEvents: listRecentSyncEvents(limit),
    conflicts: listSyncConflicts(limit),
  };
}

export function appendRemoteEvents(events: SyncEvent[], terminalId: string = DEFAULT_TERMINAL_ID): SyncConflict[] {
  const db = getDB();
  const conflicts: SyncConflict[] = [];
  const transaction = db.transaction(() => {
    for (const event of events) {
      const result = appendEventToLog(
        db,
        { ...event, state: SyncEventState.CONFIRMED },
        'REMOTE',
        terminalId,
      );
      if (result.conflict) {
        conflicts.push(result.conflict);
      }
    }
  });
  transaction();
  return conflicts;
}

export function markEventsConfirmed(
  eventIds: string[],
  serverVectorClock: VectorClock,
  deviceId: string = DEFAULT_DEVICE_ID,
  terminalId: string = DEFAULT_TERMINAL_ID,
): void {
  const db = getDB();
  if (eventIds.length > 0) {
    const placeholders = eventIds.map(() => '?').join(', ');
    db.prepare(`
      UPDATE sync_event_log
      SET state = ?
      WHERE id IN (${placeholders})
    `).run(SyncEventState.CONFIRMED, ...eventIds);
  }

  const state = getDeviceStateRow(db, deviceId, terminalId);
  db.prepare(`
    UPDATE device_state
    SET online = 1,
        remote_vector_clock = ?,
        last_sync_at = ?,
        last_error = NULL
    WHERE device_id = ?
  `).run(
    stringifyJson(serverVectorClock),
    new Date().toISOString(),
    deviceId,
  );

  db.prepare(`
    UPDATE device_state
    SET confirmed_vector_clock = ?
    WHERE device_id = ?
  `).run(state.local_vector_clock, deviceId);
}

export function recordSyncFailure(
  errorMessage: string,
  deviceId: string = DEFAULT_DEVICE_ID,
  terminalId: string = DEFAULT_TERMINAL_ID,
): void {
  const db = getDB();
  ensureDeviceState(db, deviceId, terminalId);
  db.prepare(`
    UPDATE device_state
    SET online = 0, last_error = ?
    WHERE device_id = ?
  `).run(errorMessage, deviceId);
}

export function getSyncStatus(
  deviceId: string = DEFAULT_DEVICE_ID,
  terminalId: string = DEFAULT_TERMINAL_ID,
): SyncStatusSummary {
  const db = getDB();
  return getSyncStatusInternal(db, deviceId, terminalId);
}

function addPieces(target: Map<string, number>, counts: Record<string, unknown> | undefined, sign: 1 | -1) {
  if (!counts) return;
  for (const [value, raw] of Object.entries(counts)) {
    const pieces = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (!Number.isFinite(pieces) || pieces <= 0 || !Number.isFinite(Number(value))) continue;
    target.set(value, (target.get(value) ?? 0) + (sign * Math.floor(pieces)));
  }
}

/**
 * Offline mirror of the server's drawer ledger. Kept in step with
 * `buildDrawerContents` in the backend: opening count, mid-shift movements, and
 * the notes taken in and handed back on every cash payment. Anything recorded
 * without a breakdown is reported as unaccounted rather than guessed at.
 */
export function buildLocalDrawerContents(shiftId: string): DrawerContents {
  const db = getDB();
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
  if (!shift) {
    throw new Error('Shift not found');
  }

  const cashCounts = db.prepare('SELECT * FROM shift_cash_counts WHERE shift_id = ?').all(shiftId) as any[];
  const payments = db.prepare(`
    SELECT payments.* FROM payments
    INNER JOIN sales ON sales.id = payments.sale_id
    WHERE sales.shift_id = ? AND payments.method = ?
  `).all(shiftId, PaymentMethod.CASH) as any[];

  const pieces = new Map<string, number>();
  let unaccountedIn = 0;
  let unaccountedOut = 0;
  let exact = true;

  for (const count of cashCounts) {
    const denominations = parseJson<Record<string, number> | null>(count.denominations_json, null);
    const isIncoming = count.mode === CashCountMode.OPENING || count.mode === CashCountMode.PAID_IN;
    const isOutgoing = count.mode === CashCountMode.PAID_OUT;
    if (!isIncoming && !isOutgoing) continue;

    if (denominations && Object.keys(denominations).length > 0) {
      addPieces(pieces, denominations, isIncoming ? 1 : -1);
    } else {
      if (isIncoming) unaccountedIn += count.total;
      else unaccountedOut += count.total;
      exact = false;
    }
  }

  for (const payment of payments) {
    const metadata = parseJson<Record<string, unknown> | null>(payment.metadata_json, null);
    const received = metadata?.denominations as Record<string, unknown> | undefined;
    const changeGiven = metadata?.changeDenominations as Record<string, unknown> | undefined;
    const tendered = payment.tendered_amount ?? payment.amount ?? 0;
    const changeDue = payment.change_due ?? 0;

    if (received && Object.keys(received).length > 0) {
      addPieces(pieces, received, 1);
    } else if (tendered > 0) {
      unaccountedIn += tendered;
      exact = false;
    }

    if (changeGiven && Object.keys(changeGiven).length > 0) {
      addPieces(pieces, changeGiven, -1);
    } else if (changeDue > 0) {
      unaccountedOut += changeDue;
      exact = false;
    }
  }

  const counts: Record<string, number> = {};
  let total = 0;
  for (const [value, count] of pieces) {
    if (count <= 0) {
      if (count < 0) exact = false;
      continue;
    }
    counts[value] = count;
    total += Number(value) * count;
  }

  return {
    shiftId,
    counts,
    total: Math.round(total * 100) / 100,
    exact,
    unaccountedIn: Math.round(unaccountedIn * 100) / 100,
    unaccountedOut: Math.round(unaccountedOut * 100) / 100,
  };
}

export function buildLocalZReport(shiftId: string): ZReportSummary {
  const db = getDB();
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
  if (!shift) {
    throw new Error('Shift not found');
  }

  const sales = (db.prepare('SELECT * FROM sales WHERE shift_id = ?').all(shiftId) as any[]);
  const returns = (db.prepare(`
    SELECT returns.* FROM returns
    INNER JOIN sales ON sales.id = returns.sale_id
    WHERE sales.shift_id = ?
  `).all(shiftId) as any[]);
  const paymentRows = (db.prepare(`
    SELECT payments.* FROM payments
    INNER JOIN sales ON sales.id = payments.sale_id
    WHERE sales.shift_id = ?
  `).all(shiftId) as any[]);
  const lineTotals = db.prepare(`
    SELECT
      COALESCE(SUM(sale_lines.quantity), 0) AS product_count,
      COALESCE(SUM(CASE WHEN sale_lines.discount_amount > 0 THEN 1 ELSE 0 END), 0) AS discounted_line_count
    FROM sale_lines
    INNER JOIN sales ON sales.id = sale_lines.sale_id
    WHERE sales.shift_id = ?
  `).get(shiftId) as any;
  const closingCount = db.prepare(`
    SELECT * FROM shift_cash_counts
    WHERE shift_id = ? AND mode = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(shiftId, CashCountMode.CLOSING) as any;
  const movementRows = db.prepare(`
    SELECT * FROM shift_cash_counts
    WHERE shift_id = ? AND mode IN (?, ?)
    ORDER BY created_at ASC
  `).all(shiftId, CashCountMode.PAID_IN, CashCountMode.PAID_OUT) as any[];

  const grossSales = sales.reduce((sum, sale) => sum + sale.subtotal, 0);
  const discounts = sales.reduce((sum, sale) => sum + sale.discount_total, 0);
  const refunds = returns.reduce((sum, row) => sum + row.total_refund, 0);
  const paymentBreakdown = paymentRows.reduce<Record<string, number>>((bucket, row) => {
    bucket[row.method] = (bucket[row.method] ?? 0) + row.amount;
    return bucket;
  }, {});
  const paymentCounts = paymentRows.reduce<Record<string, number>>((bucket, row) => {
    bucket[row.method] = (bucket[row.method] ?? 0) + 1;
    return bucket;
  }, {});
  const cashPaidIn = movementRows
    .filter((row) => row.mode === CashCountMode.PAID_IN)
    .reduce((sum, row) => sum + row.total, 0);
  const cashPaidOut = movementRows
    .filter((row) => row.mode === CashCountMode.PAID_OUT)
    .reduce((sum, row) => sum + row.total, 0);
  // Mid-shift movements belong here for the same reason they do on the server:
  // without them a change reload or safe drop reads as an unexplained variance.
  const expectedDrawer = shift.opening_float
    + (paymentBreakdown.CASH ?? 0)
    - refunds
    + cashPaidIn
    - cashPaidOut;

  return {
    shiftId,
    grossSales,
    discounts,
    refunds,
    netSales: sales.reduce((sum, sale) => sum + sale.total, 0) - refunds,
    transactionCount: sales.length,
    paymentBreakdown,
    expectedDrawer,
    openingFloat: shift.opening_float,
    cashPaidIn,
    cashPaidOut,
    countedDrawer: closingCount?.total ?? undefined,
    variance: closingCount ? closingCount.total - expectedDrawer : undefined,
    cashMovements: movementRows.map((row) => ({
      id: row.id,
      shiftId,
      direction: (row.mode === CashCountMode.PAID_IN ? 'in' : 'out') as 'in' | 'out',
      amount: row.total,
      reason: row.reason ?? undefined,
      denominations: parseJson<Record<string, number>>(row.denominations_json, {}),
      createdAt: row.created_at,
    })),
    paymentCounts,
    discountedLineCount: Number(lineTotals?.discounted_line_count ?? 0),
    productCount: Number(lineTotals?.product_count ?? 0),
  };
}
