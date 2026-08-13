-- Declared non-cash tender captured alongside the shift cash count, and the
-- reason recorded against a mid-shift drawer movement (change reload, safe drop).
-- Every column is nullable with no default, so existing rows and existing
-- installations upgrade in place: a cash-only declaration leaves them NULL.
ALTER TABLE "ShiftCashCount" ADD COLUMN "tenders" TEXT;

ALTER TABLE "ShiftCashCount" ADD COLUMN "tenderMode" TEXT;

ALTER TABLE "ShiftCashCount" ADD COLUMN "reason" TEXT;
