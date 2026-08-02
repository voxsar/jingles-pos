ALTER TABLE "Product" ADD COLUMN "stock_by_branch_json" TEXT;
ALTER TABLE "Product" ADD COLUMN "pricing_rules_json" TEXT;

-- This table was never read or written; Product.stockOnHand and the event ledger
-- are the actual POS stock projection.
DROP TABLE IF EXISTS "Inventory";
