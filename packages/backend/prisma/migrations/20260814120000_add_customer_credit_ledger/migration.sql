-- Adds a per-customer credit limit and an append-only ledger of repayments
-- recorded against a customer's CREDIT-tender balance.
ALTER TABLE "Customer" ADD COLUMN "creditLimit" REAL NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CreditPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "note" TEXT,
    "terminalId" TEXT,
    "userId" TEXT,
    "sourceDeviceId" TEXT,
    "sourceSequenceNum" INTEGER,
    "lastVectorClock" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CreditPayment_customerId_idx" ON "CreditPayment"("customerId");
