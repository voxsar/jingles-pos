-- SQLite stores fractional values in INTEGER-affinity columns, but Prisma's
-- Int client contract rejects them. Rebuild the affected columns as REAL so
-- sales, holds, returns, stock projections, and tier thresholds agree.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Product" (
    "id" TEXT NOT NULL PRIMARY KEY, "sku" TEXT NOT NULL, "name" TEXT NOT NULL,
    "barcode" TEXT, "barcodes_json" TEXT, "price" REAL NOT NULL, "categoryId" TEXT,
    "subcategory" TEXT NOT NULL DEFAULT '', "packSize" INTEGER NOT NULL DEFAULT 1,
    "unitLabel" TEXT NOT NULL DEFAULT 'pcs', "stockOnHand" REAL NOT NULL DEFAULT 0,
    "stock_by_branch_json" TEXT, "pricing_rules_json" TEXT, "description" TEXT,
    "variants_json" TEXT, "lastVectorClock" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Product" SELECT "id", "sku", "name", "barcode", "barcodes_json", "price", "categoryId",
    "subcategory", "packSize", "unitLabel", "stockOnHand", "stock_by_branch_json", "pricing_rules_json",
    "description", "variants_json", "lastVectorClock", "createdAt", "updatedAt" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");
CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode");

CREATE TABLE "new_BatchPrice" (
    "id" TEXT NOT NULL PRIMARY KEY, "productId" TEXT NOT NULL, "label" TEXT,
    "minQty" REAL NOT NULL, "price" REAL NOT NULL, "priority" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BatchPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_BatchPrice" SELECT "id", "productId", "label", "minQty", "price", "priority", "isDefault", "createdAt" FROM "BatchPrice";
DROP TABLE "BatchPrice";
ALTER TABLE "new_BatchPrice" RENAME TO "BatchPrice";

CREATE TABLE "new_InventoryEvent" (
    "id" TEXT NOT NULL PRIMARY KEY, "productId" TEXT NOT NULL, "eventType" TEXT NOT NULL,
    "quantity" REAL NOT NULL, "reference" TEXT, "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_InventoryEvent" SELECT "id", "productId", "eventType", "quantity", "reference", "notes", "createdAt" FROM "InventoryEvent";
DROP TABLE "InventoryEvent";
ALTER TABLE "new_InventoryEvent" RENAME TO "InventoryEvent";

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
);
INSERT INTO "new_SaleLine" SELECT "id", "saleId", "productId", "sku", "name", "barcode", "variantId",
    "variantCode", "variantName", "variant_attributes_json", "subcategory", "salespersonId", "quantity",
    "unitPrice", "tierLabel", "discountPercent", "discountAmount", "costBasis", "marginAmount", "lineTotal" FROM "SaleLine";
DROP TABLE "SaleLine";
ALTER TABLE "new_SaleLine" RENAME TO "SaleLine";

CREATE TABLE "new_HeldSaleLine" (
    "id" TEXT NOT NULL PRIMARY KEY, "heldSaleId" TEXT NOT NULL, "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL, "name" TEXT NOT NULL, "variantId" TEXT, "variantCode" TEXT,
    "variantName" TEXT, "variant_attributes_json" TEXT, "subcategory" TEXT NOT NULL DEFAULT '',
    "salespersonId" TEXT, "quantity" REAL NOT NULL, "unitPrice" REAL NOT NULL,
    "tierLabel" TEXT NOT NULL DEFAULT 'Retail', "discountPercent" REAL NOT NULL DEFAULT 0,
    "discountAmount" REAL NOT NULL DEFAULT 0, "costBasis" REAL NOT NULL DEFAULT 0,
    "lineTotal" REAL NOT NULL,
    CONSTRAINT "HeldSaleLine_heldSaleId_fkey" FOREIGN KEY ("heldSaleId") REFERENCES "HeldSale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_HeldSaleLine" SELECT "id", "heldSaleId", "productId", "sku", "name", "variantId",
    "variantCode", "variantName", "variant_attributes_json", "subcategory", "salespersonId", "quantity",
    "unitPrice", "tierLabel", "discountPercent", "discountAmount", "costBasis", "lineTotal" FROM "HeldSaleLine";
DROP TABLE "HeldSaleLine";
ALTER TABLE "new_HeldSaleLine" RENAME TO "HeldSaleLine";

CREATE TABLE "new_ReturnLine" (
    "id" TEXT NOT NULL PRIMARY KEY, "returnId" TEXT NOT NULL, "saleLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL, "variantId" TEXT, "quantity" REAL NOT NULL, "refundAmount" REAL NOT NULL,
    CONSTRAINT "ReturnLine_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReturnLine_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "SaleLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReturnLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ReturnLine" SELECT "id", "returnId", "saleLineId", "productId", "variantId", "quantity", "refundAmount" FROM "ReturnLine";
DROP TABLE "ReturnLine";
ALTER TABLE "new_ReturnLine" RENAME TO "ReturnLine";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
