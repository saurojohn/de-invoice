-- Tier 428: a customer's Zahlungsziel is optional — without one the company's
-- default payment days apply. Rows still carrying the old column default of 30
-- are set to NULL: nobody could tell them apart from a deliberate 30, and the
-- fallback lands on the company default (30 for a standard setup).
ALTER TABLE "Customer" ALTER COLUMN "paymentTerms" DROP DEFAULT;
ALTER TABLE "Customer" ALTER COLUMN "paymentTerms" DROP NOT NULL;
UPDATE "Customer" SET "paymentTerms" = NULL WHERE "paymentTerms" = 30;
