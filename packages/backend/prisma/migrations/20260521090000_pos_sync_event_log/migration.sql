-- Additive schema expansion for the standalone POS workstation and event-log sync.

ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT;
ALTER TABLE "Product" ADD COLUMN "subcategory" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN "packSize" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Product" ADD COLUMN "unitLabel" TEXT NOT NULL DEFAULT 'pcs';
ALTER TABLE "Product" ADD COLUMN "stockOnHand" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD COLUMN "lastVectorClock" TEXT;

ALTER TABLE "BatchPrice" ADD COLUMN "label" TEXT;
ALTER TABLE "BatchPrice" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BatchPrice" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Customer" ADD COLUMN "code" TEXT;
ALTER TABLE "Customer" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'Retail';
ALTER TABLE "Customer" ADD COLUMN "notes" TEXT;

ALTER TABLE "POSShift" ADD COLUMN "lastVectorClock" TEXT;
ALTER TABLE "POSShift" ADD COLUMN "synced" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Sale" ADD COLUMN "marginTotal" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN "heldSaleId" TEXT;
ALTER TABLE "Sale" ADD COLUMN "sourceDeviceId" TEXT;
ALTER TABLE "Sale" ADD COLUMN "sourceSequenceNum" INTEGER;
ALTER TABLE "Sale" ADD COLUMN "lastVectorClock" TEXT;

ALTER TABLE "SaleLine" ADD COLUMN "subcategory" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SaleLine" ADD COLUMN "salespersonId" TEXT;
ALTER TABLE "SaleLine" ADD COLUMN "tierLabel" TEXT NOT NULL DEFAULT 'Retail';
ALTER TABLE "SaleLine" ADD COLUMN "discountPercent" REAL NOT NULL DEFAULT 0;
ALTER TABLE "SaleLine" ADD COLUMN "costBasis" REAL NOT NULL DEFAULT 0;
ALTER TABLE "SaleLine" ADD COLUMN "marginAmount" REAL NOT NULL DEFAULT 0;

ALTER TABLE "Payment" ADD COLUMN "tenderedAmount" REAL;
ALTER TABLE "Payment" ADD COLUMN "metadata" TEXT;

ALTER TABLE "Return" ADD COLUMN "sourceDeviceId" TEXT;
ALTER TABLE "Return" ADD COLUMN "sourceSequenceNum" INTEGER;
ALTER TABLE "Return" ADD COLUMN "lastVectorClock" TEXT;

CREATE TABLE "Branch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "Terminal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Terminal_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "POSUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "pin" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ShiftCashCount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shiftId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "total" REAL NOT NULL,
    "denominations" TEXT NOT NULL,
    "variance" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShiftCashCount_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "POSShift" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "HeldSale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "holdNumber" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "subtotal" REAL NOT NULL,
    "discountTotal" REAL NOT NULL DEFAULT 0,
    "total" REAL NOT NULL,
    "notes" TEXT,
    "lastVectorClock" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "HeldSaleLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "heldSaleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subcategory" TEXT NOT NULL DEFAULT '',
    "salespersonId" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" REAL NOT NULL,
    "tierLabel" TEXT NOT NULL DEFAULT 'Retail',
    "discountPercent" REAL NOT NULL DEFAULT 0,
    "discountAmount" REAL NOT NULL DEFAULT 0,
    "costBasis" REAL NOT NULL DEFAULT 0,
    "lineTotal" REAL NOT NULL,
    CONSTRAINT "HeldSaleLine_heldSaleId_fkey" FOREIGN KEY ("heldSaleId") REFERENCES "HeldSale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "SyncEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "vectorClock" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "terminalId" TEXT,
    "sequenceNum" INTEGER NOT NULL,
    "lamport" INTEGER NOT NULL,
    "conflictPolicy" TEXT NOT NULL DEFAULT 'LAST_WRITE_WINS',
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" DATETIME
);

CREATE TABLE "SyncDeviceState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "terminalId" TEXT,
    "lastSequenceNum" INTEGER NOT NULL DEFAULT 0,
    "vectorClock" TEXT NOT NULL,
    "confirmedVectorClock" TEXT NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" DATETIME
);

CREATE TABLE "SyncConflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "localEventId" TEXT,
    "remoteEventId" TEXT,
    "policy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");
CREATE UNIQUE INDEX "Terminal_code_key" ON "Terminal"("code");
CREATE UNIQUE INDEX "POSUser_code_key" ON "POSUser"("code");
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code");
CREATE UNIQUE INDEX "HeldSale_holdNumber_key" ON "HeldSale"("holdNumber");
CREATE UNIQUE INDEX "SyncEvent_deviceId_sequenceNum_key" ON "SyncEvent"("deviceId", "sequenceNum");
CREATE INDEX "SyncEvent_aggregateType_aggregateId_idx" ON "SyncEvent"("aggregateType", "aggregateId");
CREATE UNIQUE INDEX "SyncDeviceState_deviceId_key" ON "SyncDeviceState"("deviceId");
