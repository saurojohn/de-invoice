-- Tier 850: the VAT rate owed out of an invoice's price (see schema.prisma)
ALTER TABLE "Invoice" ADD COLUMN "taxOutOfPrice" DECIMAL(5,4);
