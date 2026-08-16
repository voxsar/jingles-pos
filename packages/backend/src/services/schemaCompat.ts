import prisma from '../prisma';
import { isLocalPosBackendMode } from '../localMode';

type TableInfoRow = {
  name: string;
  type: string;
};

async function hasTable(tableName: string) {
  const rows = await prisma.$queryRawUnsafe<TableInfoRow[]>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    tableName,
  );

  return rows.length > 0;
}

async function tableInfo(tableName: string) {
  return prisma.$queryRawUnsafe<TableInfoRow[]>(`PRAGMA table_info("${tableName}")`);
}

async function hasColumn(tableName: string, columnName: string) {
  const rows = await tableInfo(tableName);
  return rows.some((row) => row.name === columnName);
}

/** The column's declared type affinity, e.g. `INTEGER` or `REAL` - null if the column doesn't exist. */
async function columnType(tableName: string, columnName: string) {
  const rows = await tableInfo(tableName);
  return rows.find((row) => row.name === columnName)?.type.toUpperCase() ?? null;
}

async function ensureColumn(tableName: string, columnName: string, definition: string) {
  if (await hasColumn(tableName, columnName)) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition}`,
  );
}

/**
 * Retypes the six columns migration `20260815183000_support_decimal_pos_quantities`
 * changed from INTEGER to REAL (decimal POS quantities), for desktop installs
 * that never ran that migration. `ensureColumn`'s ADD COLUMN pattern can't
 * retype an existing column, so this rebuilds each affected table exactly
 * like the migration did - SQLite has no ALTER COLUMN - gated on the column
 * still being INTEGER so it is a no-op once a database has caught up.
 *
 * Table shapes here must stay in lockstep with that migration file and with
 * schema.prisma: this is a manual replay of it, not derived from either.
 */
async function ensureDecimalQuantityColumns() {
  const needsProduct = (await columnType('Product', 'stockOnHand')) === 'INTEGER';
  const needsBatchPrice = (await columnType('BatchPrice', 'minQty')) === 'INTEGER';
  const needsInventoryEvent = (await columnType('InventoryEvent', 'quantity')) === 'INTEGER';
  const needsSaleLine = (await columnType('SaleLine', 'quantity')) === 'INTEGER';
  const needsHeldSaleLine = (await columnType('HeldSaleLine', 'quantity')) === 'INTEGER';
  const needsReturnLine = (await columnType('ReturnLine', 'quantity')) === 'INTEGER';

  if (!needsProduct && !needsBatchPrice && !needsInventoryEvent
    && !needsSaleLine && !needsHeldSaleLine && !needsReturnLine) {
    return;
  }

  await prisma.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
  try {
    if (needsProduct) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "new_Product" (
            "id" TEXT NOT NULL PRIMARY KEY, "sku" TEXT NOT NULL, "name" TEXT NOT NULL,
            "barcode" TEXT, "barcodes_json" TEXT, "price" REAL NOT NULL, "categoryId" TEXT,
            "subcategory" TEXT NOT NULL DEFAULT '', "packSize" INTEGER NOT NULL DEFAULT 1,
            "unitLabel" TEXT NOT NULL DEFAULT 'pcs', "stockOnHand" REAL NOT NULL DEFAULT 0,
            "stock_by_branch_json" TEXT, "pricing_rules_json" TEXT, "description" TEXT,
            "variants_json" TEXT, "lastVectorClock" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" DATETIME NOT NULL
        )
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "new_Product" SELECT "id", "sku", "name", "barcode", "barcodes_json", "price", "categoryId",
            "subcategory", "packSize", "unitLabel", "stockOnHand", "stock_by_branch_json", "pricing_rules_json",
            "description", "variants_json", "lastVectorClock", "createdAt", "updatedAt" FROM "Product"
      `);
      await prisma.$executeRawUnsafe('DROP TABLE "Product"');
      await prisma.$executeRawUnsafe('ALTER TABLE "new_Product" RENAME TO "Product"');
      await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku")');
      await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode")');
    }

    if (needsBatchPrice) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "new_BatchPrice" (
            "id" TEXT NOT NULL PRIMARY KEY, "productId" TEXT NOT NULL, "label" TEXT,
            "minQty" REAL NOT NULL, "price" REAL NOT NULL, "priority" INTEGER NOT NULL DEFAULT 0,
            "isDefault" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "BatchPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
        )
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "new_BatchPrice" SELECT "id", "productId", "label", "minQty", "price", "priority", "isDefault", "createdAt" FROM "BatchPrice"
      `);
      await prisma.$executeRawUnsafe('DROP TABLE "BatchPrice"');
      await prisma.$executeRawUnsafe('ALTER TABLE "new_BatchPrice" RENAME TO "BatchPrice"');
    }

    if (needsInventoryEvent) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "new_InventoryEvent" (
            "id" TEXT NOT NULL PRIMARY KEY, "productId" TEXT NOT NULL, "eventType" TEXT NOT NULL,
            "quantity" REAL NOT NULL, "reference" TEXT, "notes" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "new_InventoryEvent" SELECT "id", "productId", "eventType", "quantity", "reference", "notes", "createdAt" FROM "InventoryEvent"
      `);
      await prisma.$executeRawUnsafe('DROP TABLE "InventoryEvent"');
      await prisma.$executeRawUnsafe('ALTER TABLE "new_InventoryEvent" RENAME TO "InventoryEvent"');
    }

    if (needsSaleLine) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "new_SaleLine" (
            "id" TEXT NOT NULL PRIMARY KEY, "saleId" TEXT NOT NULL, "productId" TEXT NOT NULL,
            "sku" TEXT NOT NULL, "name" TEXT NOT NULL, "barcode" TEXT, "variantId" TEXT,
            "variantCode" TEXT, "variantName" TEXT, "variant_attributes_json" TEXT,
            "subcategory" TEXT NOT NULL DEFAULT '', "salespersonId" TEXT, "quantity" REAL NOT NULL,
            "unitPrice" REAL NOT NULL, "tierLabel" TEXT NOT NULL DEFAULT 'Retail',
            "discountPercent" REAL NOT NULL DEFAULT 0, "discountAmount" REAL NOT NULL DEFAULT 0,
            "costBasis" REAL NOT NULL DEFAULT 0, "marginAmount" REAL NOT NULL DEFAULT 0,
            "lineTotal" REAL NOT NULL,
            CONSTRAINT "SaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "SaleLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
        )
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "new_SaleLine" SELECT "id", "saleId", "productId", "sku", "name", "barcode", "variantId",
            "variantCode", "variantName", "variant_attributes_json", "subcategory", "salespersonId", "quantity",
            "unitPrice", "tierLabel", "discountPercent", "discountAmount", "costBasis", "marginAmount", "lineTotal" FROM "SaleLine"
      `);
      await prisma.$executeRawUnsafe('DROP TABLE "SaleLine"');
      await prisma.$executeRawUnsafe('ALTER TABLE "new_SaleLine" RENAME TO "SaleLine"');
    }

    if (needsHeldSaleLine) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "new_HeldSaleLine" (
            "id" TEXT NOT NULL PRIMARY KEY, "heldSaleId" TEXT NOT NULL, "productId" TEXT NOT NULL,
            "sku" TEXT NOT NULL, "name" TEXT NOT NULL, "variantId" TEXT, "variantCode" TEXT,
            "variantName" TEXT, "variant_attributes_json" TEXT, "subcategory" TEXT NOT NULL DEFAULT '',
            "salespersonId" TEXT, "quantity" REAL NOT NULL, "unitPrice" REAL NOT NULL,
            "tierLabel" TEXT NOT NULL DEFAULT 'Retail', "discountPercent" REAL NOT NULL DEFAULT 0,
            "discountAmount" REAL NOT NULL DEFAULT 0, "costBasis" REAL NOT NULL DEFAULT 0,
            "lineTotal" REAL NOT NULL,
            CONSTRAINT "HeldSaleLine_heldSaleId_fkey" FOREIGN KEY ("heldSaleId") REFERENCES "HeldSale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
        )
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "new_HeldSaleLine" SELECT "id", "heldSaleId", "productId", "sku", "name", "variantId",
            "variantCode", "variantName", "variant_attributes_json", "subcategory", "salespersonId", "quantity",
            "unitPrice", "tierLabel", "discountPercent", "discountAmount", "costBasis", "lineTotal" FROM "HeldSaleLine"
      `);
      await prisma.$executeRawUnsafe('DROP TABLE "HeldSaleLine"');
      await prisma.$executeRawUnsafe('ALTER TABLE "new_HeldSaleLine" RENAME TO "HeldSaleLine"');
    }

    if (needsReturnLine) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE "new_ReturnLine" (
            "id" TEXT NOT NULL PRIMARY KEY, "returnId" TEXT NOT NULL, "saleLineId" TEXT NOT NULL,
            "productId" TEXT NOT NULL, "variantId" TEXT, "quantity" REAL NOT NULL, "refundAmount" REAL NOT NULL,
            CONSTRAINT "ReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "ReturnLine_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "SaleLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
            CONSTRAINT "ReturnLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
        )
      `);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "new_ReturnLine" SELECT "id", "returnId", "saleLineId", "productId", "variantId", "quantity", "refundAmount" FROM "ReturnLine"
      `);
      await prisma.$executeRawUnsafe('DROP TABLE "ReturnLine"');
      await prisma.$executeRawUnsafe('ALTER TABLE "new_ReturnLine" RENAME TO "ReturnLine"');
    }
  } finally {
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys=ON');
  }
}

export async function ensureLocalSchemaCompat() {
  if (!isLocalPosBackendMode()) {
    return;
  }

  // Desktop installs can lag behind migrations. Keep this list explicit so a
  // startup check cannot replay destructive SQL from historical migrations.
  await ensureColumn('SyncDeviceState', 'online', 'BOOLEAN NOT NULL DEFAULT false');
  await ensureColumn('SyncDeviceState', 'lastError', 'TEXT');
  await ensureColumn('POSUser', 'password_hash', 'TEXT');
  await ensureColumn('POSUser', 'access_scope', "TEXT NOT NULL DEFAULT 'BOTH'");
  await ensureColumn('POSUser', 'is_salesman', 'BOOLEAN NOT NULL DEFAULT true');
  await ensureColumn('Product', 'variants_json', 'TEXT');
  await ensureColumn('Product', 'barcodes_json', 'TEXT');
  await ensureColumn('HeldSaleLine', 'variantId', 'TEXT');
  await ensureColumn('HeldSaleLine', 'variantCode', 'TEXT');
  await ensureColumn('HeldSaleLine', 'variantName', 'TEXT');
  await ensureColumn('HeldSaleLine', 'variant_attributes_json', 'TEXT');
  await ensureColumn('SaleLine', 'variantId', 'TEXT');
  await ensureColumn('SaleLine', 'variantCode', 'TEXT');
  await ensureColumn('SaleLine', 'variantName', 'TEXT');
  await ensureColumn('SaleLine', 'variant_attributes_json', 'TEXT');
  await ensureColumn('ReturnLine', 'variantId', 'TEXT');
  await ensureColumn('ShiftCashCount', 'tenders', 'TEXT');
  await ensureColumn('ShiftCashCount', 'tenderMode', 'TEXT');
  await ensureColumn('ShiftCashCount', 'reason', 'TEXT');
  await ensureColumn('Customer', 'creditLimit', 'REAL NOT NULL DEFAULT 0');

  if (!(await hasTable('ConfigEntry'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "ConfigEntry" (
        "key" TEXT NOT NULL PRIMARY KEY,
        "value" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  if (!(await hasTable('CreditPayment'))) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "CreditPayment" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "customerId" TEXT NOT NULL,
        "amount" REAL NOT NULL,
        "method" TEXT NOT NULL DEFAULT 'CASH',
        "note" TEXT,
        "terminalId" TEXT,
        "userId" TEXT,
        "shiftId" TEXT,
        "sourceDeviceId" TEXT,
        "sourceSequenceNum" INTEGER,
        "lastVectorClock" TEXT NOT NULL DEFAULT '{}',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "CreditPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "CreditPayment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "POSShift" ("id") ON DELETE SET NULL ON UPDATE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX "CreditPayment_customerId_idx" ON "CreditPayment"("customerId")
    `);
  }

  await ensureColumn('CreditPayment', 'shiftId', 'TEXT');
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "CreditPayment_shiftId_idx" ON "CreditPayment"("shiftId")
  `);

  await ensureDecimalQuantityColumns();
}
