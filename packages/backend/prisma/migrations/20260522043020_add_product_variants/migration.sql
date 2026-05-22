ALTER TABLE "Product" ADD COLUMN "variants_json" TEXT;

ALTER TABLE "HeldSaleLine" ADD COLUMN "variantId" TEXT;
ALTER TABLE "HeldSaleLine" ADD COLUMN "variantCode" TEXT;
ALTER TABLE "HeldSaleLine" ADD COLUMN "variantName" TEXT;
ALTER TABLE "HeldSaleLine" ADD COLUMN "variant_attributes_json" TEXT;

ALTER TABLE "SaleLine" ADD COLUMN "variantId" TEXT;
ALTER TABLE "SaleLine" ADD COLUMN "variantCode" TEXT;
ALTER TABLE "SaleLine" ADD COLUMN "variantName" TEXT;
ALTER TABLE "SaleLine" ADD COLUMN "variant_attributes_json" TEXT;

ALTER TABLE "ReturnLine" ADD COLUMN "variantId" TEXT;
