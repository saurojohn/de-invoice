-- Tier 928: the customer's country and VAT id as on the day of issue (see schema.prisma)
ALTER TABLE "Invoice" ADD COLUMN "customerCountry" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "customerVatId" TEXT;
-- issued before: the customer's data as it stands — the best there is
UPDATE "Invoice" i
SET "customerCountry" = COALESCE(c."address"->>'country', ''),
    "customerVatId" = c."vatId"
FROM "Customer" c
WHERE c."id" = i."customerId" AND i."status" <> 'draft';
