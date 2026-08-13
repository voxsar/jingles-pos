-- Declared non-cash tender captured alongside the shift cash count.
-- Both columns are nullable with no default, so existing rows and existing
-- installations upgrade in place: a cash-only declaration simply leaves them NULL.
ALTER TABLE "ShiftCashCount" ADD COLUMN "tenders" TEXT;

ALTER TABLE "ShiftCashCount" ADD COLUMN "tenderMode" TEXT;
