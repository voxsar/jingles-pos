-- Attribute customer bill collections to the cashier shift that received them.
ALTER TABLE "CreditPayment" ADD COLUMN "shiftId" TEXT REFERENCES "POSShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CreditPayment_shiftId_idx" ON "CreditPayment"("shiftId");
