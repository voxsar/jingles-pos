import path from 'path';
import { createHash } from 'crypto';
import type { POSUser, ProductPriceTier, Product, ProductVariant, SharedCatalogSnapshot } from '@jingles/shared';
import prisma from '../prisma';
import { isLocalPosBackendMode } from '../localMode';

type LocalProductRow = {
  id: string;
  sku: string;
  barcode: string | null;
  barcodesJson: string | null;
  name: string;
  categoryId: string | null;
  subcategory: string;
  packSize: number;
  unitLabel: string;
  stockOnHand: number;
  stockByBranchJson: string | null;
  pricingRulesJson: string | null;
  description: string | null;
  variantsJson: string | null;
};

type DirectSqliteStatement = {
  run: (...params: Array<string | number | null>) => unknown;
  get: (...params: Array<string | number | null>) => Record<string, unknown> | undefined;
};

type DirectSqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => DirectSqliteStatement;
  close: () => void;
};

type DirectSqliteDatabaseSyncConstructor = new (location: string) => DirectSqliteDatabase;

const LOCAL_CATALOG_BULK_REFRESH_TIMEOUT_MS = 300_000;
const LOCAL_CATALOG_REPLACE_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: LOCAL_CATALOG_BULK_REFRESH_TIMEOUT_MS,
} as const;
const LOCAL_CATALOG_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS product_search_ai
  AFTER INSERT ON "Product"
  BEGIN
    INSERT INTO product_search (id, sku, barcode, name, subcategory, description)
    VALUES (
      NEW.id,
      NEW.sku,
      COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(NEW.barcodes_json, '[]'))), COALESCE(NEW.barcode, '')),
      NEW.name,
      COALESCE(NEW.subcategory, ''),
      COALESCE(NEW.description, '')
    );
  END;

  CREATE TRIGGER IF NOT EXISTS product_search_ad
  AFTER DELETE ON "Product"
  BEGIN
    DELETE FROM product_search WHERE id = OLD.id;
  END;

  CREATE TRIGGER IF NOT EXISTS product_search_au
  AFTER UPDATE ON "Product"
  BEGIN
    DELETE FROM product_search WHERE id = OLD.id;
    INSERT INTO product_search (id, sku, barcode, name, subcategory, description)
    VALUES (
      NEW.id,
      NEW.sku,
      COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(NEW.barcodes_json, '[]'))), COALESCE(NEW.barcode, '')),
      NEW.name,
      COALESCE(NEW.subcategory, ''),
      COALESCE(NEW.description, '')
    );
  END;
`;
const LOCAL_CATALOG_DROP_TRIGGER_SQL = `
  DROP TRIGGER IF EXISTS product_search_ai;
  DROP TRIGGER IF EXISTS product_search_ad;
  DROP TRIGGER IF EXISTS product_search_au;
`;

function sortTiers<T extends { priority: number; minQty: number }>(tiers: T[]): T[] {
  return [...tiers].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return left.minQty - right.minQty;
  });
}

function parseVariantsJson(value: string | null | undefined): ProductVariant[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as ProductVariant[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapPriceTiers(
  tiers: Array<{
    id: string;
    label: string | null;
    price: number;
    priority: number;
    minQty: number;
    isDefault: boolean;
  }>,
): ProductPriceTier[] {
  return sortTiers(
    tiers.map((tier) => ({
      id: tier.id,
      label: tier.label ?? (tier.minQty > 0 ? `Bulk ${tier.minQty}+` : 'Retail'),
      price: tier.price,
      priority: tier.priority ?? 0,
      minQty: tier.minQty ?? 0,
      isDefault: tier.isDefault ?? false,
    })),
  );
}

function mapProductRow(
  product: LocalProductRow,
  tiers: Array<{
    id: string;
    label: string | null;
    price: number;
    priority: number;
    minQty: number;
    isDefault: boolean;
  }>,
): Product {
  return {
    id: product.id,
    sku: product.sku,
    barcode: product.barcode ?? undefined,
    barcodes: parseJsonArray<string>(product.barcodesJson),
    name: product.name,
    categoryId: product.categoryId ?? 'uncategorized',
    subcategory: product.subcategory ?? '',
    packSize: product.packSize ?? 1,
    unitLabel: product.unitLabel ?? 'pcs',
    stockOnHand: product.stockOnHand ?? 0,
    stockByBranch: parseJsonRecord(product.stockByBranchJson),
    description: product.description ?? undefined,
    priceTiers: mapPriceTiers(tiers),
    variants: parseVariantsJson(product.variantsJson),
    pricingRules: parseJsonArray(product.pricingRulesJson),
  };
}

function parseJsonRecord(value: string | null | undefined): Record<string, number> {
  try { const parsed = JSON.parse(value ?? '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  try { const parsed = JSON.parse(value ?? '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export async function ensureLocalCatalogSearchIndex() {
  if (!isLocalPosBackendMode()) {
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS product_search USING fts5(
      id UNINDEXED,
      sku,
      barcode,
      name,
      subcategory,
      description
    )
  `);

  // Replace triggers created by older releases so future catalog updates keep
  // indexing every alias, not just the preferred barcode.
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS product_search_ai');
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS product_search_ad');
  await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS product_search_au');

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER IF NOT EXISTS product_search_ai
    AFTER INSERT ON "Product"
    BEGIN
      INSERT INTO product_search (id, sku, barcode, name, subcategory, description)
      VALUES (
        NEW.id,
        NEW.sku,
        COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(NEW.barcodes_json, '[]'))), COALESCE(NEW.barcode, '')),
        NEW.name,
        COALESCE(NEW.subcategory, ''),
        COALESCE(NEW.description, '')
      );
    END
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER IF NOT EXISTS product_search_ad
    AFTER DELETE ON "Product"
    BEGIN
      DELETE FROM product_search WHERE id = OLD.id;
    END
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER IF NOT EXISTS product_search_au
    AFTER UPDATE ON "Product"
    BEGIN
      DELETE FROM product_search WHERE id = OLD.id;
      INSERT INTO product_search (id, sku, barcode, name, subcategory, description)
      VALUES (
        NEW.id,
        NEW.sku,
        COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(NEW.barcodes_json, '[]'))), COALESCE(NEW.barcode, '')),
        NEW.name,
        COALESCE(NEW.subcategory, ''),
        COALESCE(NEW.description, '')
      );
    END
  `);

  await rebuildLocalCatalogSearchIndex();
}

export async function rebuildLocalCatalogSearchIndex() {
  if (!isLocalPosBackendMode()) {
    return;
  }

  await prisma.$executeRawUnsafe('DELETE FROM product_search');
  await prisma.$executeRawUnsafe(`
    INSERT INTO product_search (id, sku, barcode, name, subcategory, description)
    SELECT
      id,
      sku,
      COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(barcodes_json, '[]'))), COALESCE(barcode, '')),
      name,
      COALESCE(subcategory, ''),
      COALESCE(description, '')
    FROM "Product"
  `);
}

function resolveLocalCatalogDatabasePath() {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    return null;
  }

  const withoutQuery = raw.split('?')[0];
  if (!withoutQuery.startsWith('file:')) {
    return null;
  }

  const filePath = decodeURIComponent(withoutQuery.slice('file:'.length));
  if (/^[a-z]:/i.test(filePath) || filePath.startsWith('/') || filePath.startsWith('\\')) {
    return filePath;
  }

  return path.resolve(process.cwd(), filePath);
}

function openDirectCatalogDatabase(): DirectSqliteDatabase | null {
  const databasePath = resolveLocalCatalogDatabasePath();
  if (!databasePath) {
    return null;
  }

  let DatabaseSync: DirectSqliteDatabaseSyncConstructor | undefined;
  try {
    ({ DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: DirectSqliteDatabaseSyncConstructor;
    });
  } catch {
    return null;
  }

  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout = ${LOCAL_CATALOG_BULK_REFRESH_TIMEOUT_MS};`);
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function ensureLocalCatalogSearchIndexDirect(db: DirectSqliteDatabase) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS product_search USING fts5(
      id UNINDEXED,
      sku,
      barcode,
      name,
      subcategory,
      description
    )
  `);
  db.exec(LOCAL_CATALOG_TRIGGER_SQL);
}

function rebuildLocalCatalogSearchIndexDirect(db: DirectSqliteDatabase) {
  db.prepare('DELETE FROM product_search').run();
  db.prepare(`
    INSERT INTO product_search (id, sku, barcode, name, subcategory, description)
    SELECT
      id,
      sku,
      COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(barcodes_json, '[]'))), COALESCE(barcode, '')),
      name,
      COALESCE(subcategory, ''),
      COALESCE(description, '')
    FROM "Product"
  `).run();
}

function replaceLocalCatalogSnapshotDirect(snapshot: SharedCatalogSnapshot) {
  if (!isLocalPosBackendMode()) {
    return false;
  }

  const db = openDirectCatalogDatabase();
  if (!db) {
    return false;
  }

  try {
    ensureLocalCatalogSearchIndexDirect(db);

    const snapshotHash = createHash('sha256')
      .update(JSON.stringify({
        branches: snapshot.branches ?? [],
        users: snapshot.users ?? [],
        customers: snapshot.customers ?? [],
        categories: snapshot.categories,
        products: snapshot.products,
      }))
      .digest('hex');
    const existingHash = db.prepare(
      'SELECT value FROM "ConfigEntry" WHERE key=?',
    ).get('catalogSnapshotHash')?.value;
    if (existingHash === snapshotHash) {
      return true;
    }

    const insertCategory = db.prepare(`
      INSERT INTO "Category" (id, name, icon, sortOrder, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon,
        sortOrder=excluded.sortOrder, updatedAt=CURRENT_TIMESTAMP
    `);
    const insertProduct = db.prepare(`
      INSERT INTO "Product" (
        id, sku, barcode, barcodes_json, name, price, categoryId, subcategory, packSize,
        unitLabel, stockOnHand, stock_by_branch_json, pricing_rules_json, description, variants_json, lastVectorClock, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, barcode=excluded.barcode, barcodes_json=excluded.barcodes_json,
        name=excluded.name, price=excluded.price, categoryId=excluded.categoryId,
        subcategory=excluded.subcategory, packSize=excluded.packSize,
        unitLabel=excluded.unitLabel, stockOnHand=excluded.stockOnHand,
        stock_by_branch_json=excluded.stock_by_branch_json,
        pricing_rules_json=excluded.pricing_rules_json,
        description=excluded.description, variants_json=excluded.variants_json,
        lastVectorClock=excluded.lastVectorClock, updatedAt=CURRENT_TIMESTAMP
    `);
    const upsertBranch = db.prepare(`
      INSERT INTO "Branch" (id, code, name, createdAt, updatedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, updatedAt=CURRENT_TIMESTAMP
    `);
    const alignBranchId = db.prepare(`
      UPDATE "Branch" SET id=?, updatedAt=CURRENT_TIMESTAMP WHERE code=? AND id<>?
    `);
    const ensureBranchTerminal = db.prepare(`
      INSERT INTO "Terminal" (id, code, name, branchId, createdAt, updatedAt)
      SELECT ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      WHERE NOT EXISTS (SELECT 1 FROM "Terminal" WHERE branchId=?)
      ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name,
        branchId=excluded.branchId, updatedAt=CURRENT_TIMESTAMP
    `);
    const upsertUser = db.prepare(`
      INSERT INTO "POSUser" (id, code, email, name, initials, role, access_scope, is_salesman, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET code=excluded.code, email=excluded.email, name=excluded.name,
        initials=excluded.initials, role=excluded.role, access_scope=excluded.access_scope,
        is_salesman=excluded.is_salesman, updatedAt=CURRENT_TIMESTAMP
    `);
    const upsertCustomer = db.prepare(`
      INSERT INTO "Customer" (id, code, name, tier, email, phone, notes, creditLimit, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, tier=excluded.tier,
        email=excluded.email, phone=excluded.phone, notes=excluded.notes,
        creditLimit=excluded.creditLimit, updatedAt=CURRENT_TIMESTAMP
    `);
    const userReferenceTables = [
      ['POSShift', 'userId'],
      ['Sale', 'userId'],
      ['HeldSale', 'userId'],
      ['Return', 'userId'],
      ['SaleLine', 'salespersonId'],
      ['HeldSaleLine', 'salespersonId'],
    ] as const;
    const insertBatchPrice = db.prepare(`
      INSERT INTO "BatchPrice" (id, productId, label, minQty, price, priority, isDefault, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    db.exec(LOCAL_CATALOG_DROP_TRIGGER_SQL);
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare('DELETE FROM product_search').run();
      db.prepare('DELETE FROM "BatchPrice"').run();

      // Keep historical foreign keys valid, but remove users absent from the
      // authoritative Inventory snapshot from active POS staff lists.
      db.prepare('UPDATE "POSUser" SET is_salesman=0, access_scope=\'INVENTORY\', updatedAt=CURRENT_TIMESTAMP').run();

      db.exec('CREATE TEMP TABLE IF NOT EXISTS catalog_snapshot_products (id TEXT PRIMARY KEY);');
      db.prepare('DELETE FROM catalog_snapshot_products').run();
      const markSnapshotProduct = db.prepare('INSERT INTO catalog_snapshot_products (id) VALUES (?)');
      for (const product of snapshot.products) markSnapshotProduct.run(product.id);

      // Preserve products referenced by historical sales/returns, while
      // removing obsolete unreferenced catalog rows. Current products are
      // updated in-place below so their foreign-key identity remains stable.
      db.prepare(`
        DELETE FROM "Product"
        WHERE NOT EXISTS (SELECT 1 FROM catalog_snapshot_products active WHERE active.id = "Product".id)
          AND NOT EXISTS (SELECT 1 FROM "SaleLine" line WHERE line.productId = "Product".id)
          AND NOT EXISTS (SELECT 1 FROM "ReturnLine" line WHERE line.productId = "Product".id)
      `).run();

      for (const branch of snapshot.branches ?? []) {
        // Branch codes are the stable business identity in older POS caches.
        // Align a legacy local UUID first; Terminal foreign keys cascade to it.
        alignBranchId.run(branch.id, branch.code, branch.id);
        upsertBranch.run(branch.id, branch.code, branch.name);
      }
      for (const user of snapshot.users ?? []) {
        if (user.email) {
          for (const [table, column] of userReferenceTables) {
            db.prepare(`
              UPDATE "${table}" SET "${column}"=?
              WHERE "${column}" IN (SELECT id FROM "POSUser" WHERE email=? AND id<>?)
            `).run(user.id, user.email, user.id);
          }
          db.prepare('DELETE FROM "POSUser" WHERE email=? AND id<>?').run(user.email, user.id);
        }
        upsertUser.run(user.id, user.code, user.email ?? null, user.name, user.initials, user.role, user.accessScope ?? 'BOTH', user.isSalesman !== false ? 1 : 0);
      }
      for (const customer of snapshot.customers ?? []) {
        const duplicate = customer.code
          ? db.prepare('SELECT id FROM "Customer" WHERE code=? AND id<>?').get(customer.code, customer.id) as { id: string } | undefined
          : undefined;
        const emailDuplicate = !duplicate && customer.email
          ? db.prepare('SELECT id FROM "Customer" WHERE email=? AND id<>?').get(customer.email, customer.id) as { id: string } | undefined
          : undefined;
        const oldId = duplicate?.id ?? emailDuplicate?.id;
        if (oldId) {
          // Free the unique business keys, create the server identity, and only
          // then repoint historical foreign keys so SQLite FK checks stay valid.
          db.prepare('UPDATE "Customer" SET code=NULL, email=NULL WHERE id=?').run(oldId);
          upsertCustomer.run(
            customer.id, customer.code || null, customer.name, customer.tier,
            customer.email ?? null, customer.phone ?? null, customer.notes ?? null,
            customer.creditLimit ?? 0,
          );
          db.prepare('UPDATE "Sale" SET customerId=? WHERE customerId=?').run(customer.id, oldId);
          db.prepare('UPDATE "HeldSale" SET customerId=? WHERE customerId=?').run(customer.id, oldId);
          db.prepare('UPDATE "CreditPayment" SET customerId=? WHERE customerId=?').run(customer.id, oldId);
          db.prepare('DELETE FROM "Customer" WHERE id=?').run(oldId);
        } else {
          upsertCustomer.run(
            customer.id, customer.code || null, customer.name, customer.tier,
            customer.email ?? null, customer.phone ?? null, customer.notes ?? null,
            customer.creditLimit ?? 0,
          );
        }
      }
      if (snapshot.branches?.length) {
        const ids = snapshot.branches.map((branch) => `'${branch.id.replace(/'/g, "''")}'`).join(',');
        db.exec(`UPDATE "Terminal" SET branchId='${snapshot.branches[0]!.id.replace(/'/g, "''")}' WHERE branchId NOT IN (${ids});`);
        for (const branch of snapshot.branches) {
          ensureBranchTerminal.run(
            `terminal-branch-${branch.id}`,
            `POS-${branch.code}`,
            `${branch.name} POS`,
            branch.id,
            branch.id,
          );
        }
      }

      for (const category of snapshot.categories) {
        insertCategory.run(category.id, category.name, category.icon, category.sortOrder);
      }

      for (const product of snapshot.products) {
        insertProduct.run(
          product.id,
          product.sku,
          product.barcode ?? null,
          JSON.stringify(product.barcodes ?? (product.barcode ? [product.barcode] : [])),
          product.name,
          product.priceTiers[0]?.price ?? 0,
          product.categoryId ?? null,
          product.subcategory,
          Math.max(1, Math.round(product.packSize || 1)),
          product.unitLabel,
          Math.max(0, product.stockOnHand),
          JSON.stringify(product.stockByBranch ?? {}),
          JSON.stringify(product.pricingRules ?? []),
          product.description ?? null,
          JSON.stringify(product.variants ?? []),
          '{}',
        );

        for (const tier of product.priceTiers) {
          insertBatchPrice.run(
            tier.id,
            product.id,
            tier.label,
            tier.minQty ?? 0,
            tier.price,
            tier.priority,
            tier.isDefault ? 1 : 0,
          );
        }
      }

      db.prepare(`
        DELETE FROM "Category"
        WHERE NOT EXISTS (SELECT 1 FROM "Product" WHERE "Product".categoryId = "Category".id)
      `).run();

      db.prepare(`
        INSERT INTO "ConfigEntry" (key, value, createdAt, updatedAt)
        VALUES ('catalogSnapshotHash', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=CURRENT_TIMESTAMP
      `).run(snapshotHash);

      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    } finally {
      db.exec(LOCAL_CATALOG_TRIGGER_SQL);
    }

    rebuildLocalCatalogSearchIndexDirect(db);
    return true;
  } finally {
    db.close();
  }
}

export async function getLocalCatalogSnapshot(): Promise<SharedCatalogSnapshot> {
  const [branches, users, customers, categories, products] = await Promise.all([
    prisma.branch.findMany({ orderBy: { code: 'asc' } }),
    prisma.pOSUser.findMany({ orderBy: { code: 'asc' } }),
    prisma.customer.findMany({ orderBy: { name: 'asc' } }),
    prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.product.findMany({
      include: {
        batchPrices: {
          orderBy: [{ priority: 'asc' }, { minQty: 'asc' }, { label: 'asc' }],
        },
      },
      orderBy: { sku: 'asc' },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    branches,
    users: users.map((user) => ({
      id: user.id,
      code: user.code,
      email: user.email ?? undefined,
      name: user.name,
      initials: user.initials,
      role: user.role as POSUser['role'],
    })),
    customers: customers.map((customer) => ({
      id: customer.id,
      code: customer.code ?? customer.id,
      name: customer.name,
      tier: customer.tier,
      phone: customer.phone ?? undefined,
      email: customer.email ?? undefined,
      notes: customer.notes ?? undefined,
      creditLimit: customer.creditLimit ?? 0,
    })),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      icon: category.icon ?? category.name.slice(0, 2).toUpperCase(),
      sortOrder: category.sortOrder ?? 0,
    })),
    products: products.map((product) => mapProductRow(product, product.batchPrices)),
  };
}

export async function replaceLocalCatalogSnapshot(snapshot: SharedCatalogSnapshot) {
  if (replaceLocalCatalogSnapshotDirect(snapshot)) {
    return;
  }

  const categoryRows = snapshot.categories.map((category) => ({
    id: category.id,
    name: category.name,
    icon: category.icon,
    sortOrder: category.sortOrder,
  }));
  const productRows = snapshot.products.map((product) => ({
    id: product.id,
    sku: product.sku,
    barcode: product.barcode ?? null,
    barcodesJson: JSON.stringify(product.barcodes ?? (product.barcode ? [product.barcode] : [])),
    name: product.name,
    price: product.priceTiers[0]?.price ?? 0,
    categoryId: product.categoryId,
    subcategory: product.subcategory,
    packSize: Math.max(1, Math.round(product.packSize || 1)),
    unitLabel: product.unitLabel,
    stockOnHand: Math.max(0, product.stockOnHand),
    stockByBranchJson: JSON.stringify(product.stockByBranch ?? {}),
    pricingRulesJson: JSON.stringify(product.pricingRules ?? []),
    description: product.description ?? null,
    variantsJson: JSON.stringify(product.variants ?? []),
    lastVectorClock: '{}',
  }));
  const batchPriceRows = snapshot.products.flatMap((product) =>
    product.priceTiers.map((tier) => ({
      id: tier.id,
      productId: product.id,
      label: tier.label,
      price: tier.price,
      priority: tier.priority,
      minQty: tier.minQty ?? 0,
      isDefault: tier.isDefault ?? false,
    })),
  );

  await prisma.$transaction(async (tx) => {
    for (const branch of snapshot.branches ?? []) {
      await tx.branch.upsert({ where: { id: branch.id }, create: branch, update: { code: branch.code, name: branch.name } });
    }
    await tx.pOSUser.updateMany({ data: { isSalesman: false, accessScope: 'INVENTORY' } });
    for (const user of snapshot.users ?? []) {
      await tx.pOSUser.upsert({
        where: { id: user.id },
        create: user,
        update: { code: user.code, email: user.email, name: user.name, initials: user.initials, role: user.role, accessScope: user.accessScope ?? 'BOTH', isSalesman: user.isSalesman !== false },
      });
    }
    for (const customer of snapshot.customers ?? []) {
      const existing = await tx.customer.findFirst({
        where: {
          OR: [
            { id: customer.id },
            ...(customer.code ? [{ code: customer.code }] : []),
            ...(customer.email ? [{ email: customer.email }] : []),
          ],
        },
      });
      const data = {
        code: customer.code || null,
        name: customer.name,
        tier: customer.tier,
        email: customer.email ?? null,
        phone: customer.phone ?? null,
        notes: customer.notes ?? null,
        creditLimit: customer.creditLimit ?? 0,
      };
      if (existing) await tx.customer.update({ where: { id: existing.id }, data });
      else await tx.customer.create({ data: { id: customer.id, ...data } });
    }
    if (snapshot.branches?.length) {
      await tx.terminal.updateMany({ where: { branchId: { notIn: snapshot.branches.map((branch) => branch.id) } }, data: { branchId: snapshot.branches[0]!.id } });
    }
    await tx.batchPrice.deleteMany();
    await tx.product.deleteMany();
    await tx.category.deleteMany();

    if (categoryRows.length > 0) {
      await tx.category.createMany({
        data: categoryRows,
      });
    }

    if (productRows.length > 0) {
      await tx.product.createMany({
        data: productRows,
      });
    }

    if (batchPriceRows.length > 0) {
      await tx.batchPrice.createMany({ data: batchPriceRows });
    }
  }, LOCAL_CATALOG_REPLACE_TRANSACTION_OPTIONS);

  await rebuildLocalCatalogSearchIndex();
}

/** Makes an accepted upstream price visible to the very next local lookup. */
export async function applyLocalCatalogPriceOverride(input: {
  productId: string;
  variantId?: string | null;
  tierLabel: string;
  price: number;
  batchId: string;
}) {
  const tierKey = input.tierLabel.trim().toLowerCase();
  const db = isLocalPosBackendMode() ? openDirectCatalogDatabase() : null;
  if (db) {
    try {
      if (input.variantId) {
        const row = db.prepare('SELECT variants_json AS variantsJson FROM "Product" WHERE id=?').get(input.productId) as { variantsJson?: string | null } | undefined;
        const variants = JSON.parse(row?.variantsJson || '[]') as ProductVariant[];
        const updated = variants.map((variant) => variant.id !== input.variantId ? variant : {
          ...variant,
          priceTiers: (variant.priceTiers ?? []).map((tier) => tier.label.trim().toLowerCase() === tierKey ? { ...tier, price: input.price } : tier),
        });
        db.prepare('UPDATE "Product" SET variants_json=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(updated), input.productId);
      } else {
        const existing = db.prepare('SELECT id FROM "BatchPrice" WHERE productId=? AND lower(label)=? ORDER BY priority, minQty LIMIT 1').get(input.productId, tierKey) as { id?: string } | undefined;
        if (existing?.id) {
          db.prepare('UPDATE "BatchPrice" SET price=? WHERE id=?').run(input.price, existing.id);
        } else {
          db.prepare('INSERT INTO "BatchPrice" (id, productId, label, minQty, price, priority, isDefault, createdAt) VALUES (?, ?, ?, 0, ?, 0, 0, CURRENT_TIMESTAMP)').run(input.batchId, input.productId, input.tierLabel, input.price);
        }
        if (tierKey === 'retail') db.prepare('UPDATE "Product" SET price=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?').run(input.price, input.productId);
      }
      return;
    } finally {
      db.close();
    }
  }

  if (input.variantId) {
    const product = await prisma.product.findUnique({ where: { id: input.productId } });
    const variants = JSON.parse(product?.variantsJson || '[]') as ProductVariant[];
    await prisma.product.update({
      where: { id: input.productId },
      data: {
        variantsJson: JSON.stringify(variants.map((variant) => variant.id !== input.variantId ? variant : {
          ...variant,
          priceTiers: (variant.priceTiers ?? []).map((tier) => tier.label.trim().toLowerCase() === tierKey ? { ...tier, price: input.price } : tier),
        })),
      },
    });
    return;
  }

  const existing = await prisma.batchPrice.findFirst({ where: { productId: input.productId, label: input.tierLabel } });
  if (existing) await prisma.batchPrice.update({ where: { id: existing.id }, data: { price: input.price } });
  else await prisma.batchPrice.create({ data: { id: input.batchId, productId: input.productId, label: input.tierLabel, minQty: 0, price: input.price } });
  if (tierKey === 'retail') await prisma.product.update({ where: { id: input.productId }, data: { price: input.price } });
}

export function buildFtsQuery(query: string) {
  const tokens = query
    .trim()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return '';
  }

  const lastToken = tokens.pop()!;
  return [...tokens, `${lastToken}*`].join(' ');
}

async function getProductsByIds(ids: string[]) {
  if (ids.length === 0) {
    return [];
  }

  const rows = await prisma.product.findMany({
    where: { id: { in: ids } },
    include: {
      batchPrices: {
        orderBy: [{ priority: 'asc' }, { minQty: 'asc' }, { label: 'asc' }],
      },
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => mapProductRow(row, row.batchPrices));
}

export async function searchLocalCatalog(query: string) {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    const rows = await prisma.product.findMany({
      include: {
        batchPrices: {
          orderBy: [{ priority: 'asc' }, { minQty: 'asc' }, { label: 'asc' }],
        },
      },
      orderBy: { sku: 'asc' },
      take: 30,
    });
    return rows.map((row) => mapProductRow(row, row.batchPrices));
  }

  if (!isLocalPosBackendMode()) {
    const rows = await prisma.product.findMany({
      where: {
        OR: [
          { sku: { contains: trimmedQuery } },
          { name: { contains: trimmedQuery } },
          { barcode: trimmedQuery },
          { barcodesJson: { contains: trimmedQuery } },
          { subcategory: { contains: trimmedQuery } },
        ],
      },
      include: {
        batchPrices: {
          orderBy: [{ priority: 'asc' }, { minQty: 'asc' }, { label: 'asc' }],
        },
      },
      orderBy: { sku: 'asc' },
      take: 30,
    });

    return rows.map((row) => mapProductRow(row, row.batchPrices));
  }

  const exactBarcodeIds = (
    await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `
        SELECT id
        FROM "Product"
         WHERE barcode = ?
            OR EXISTS (
              SELECT 1 FROM json_each(COALESCE(barcodes_json, '[]')) aliases
              WHERE aliases.value = ?
            )
        ORDER BY sku ASC
        LIMIT 5
      `,
      trimmedQuery,
      trimmedQuery,
    )
  ).map((row) => row.id);

  const ftsQuery = buildFtsQuery(trimmedQuery);
  if (!ftsQuery) {
    return getProductsByIds(exactBarcodeIds);
  }

  const ftsIds = (
    await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `
        SELECT p.id
        FROM product_search
        INNER JOIN "Product" p ON p.id = product_search.id
        WHERE product_search MATCH ?
          AND p.id NOT IN (
            SELECT id
            FROM "Product"
             WHERE barcode = ?
                OR EXISTS (
                  SELECT 1 FROM json_each(COALESCE(barcodes_json, '[]')) aliases
                  WHERE aliases.value = ?
                )
          )
        ORDER BY bm25(product_search), p.sku ASC
        LIMIT 30
      `,
      ftsQuery,
      trimmedQuery,
      trimmedQuery,
    )
  ).map((row) => row.id);

  return getProductsByIds([...exactBarcodeIds, ...ftsIds]);
}
