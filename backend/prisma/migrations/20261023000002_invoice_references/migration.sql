-- Tier 729b: the customer's order number (BT-13) and reference (BT-10) on an invoice.
ALTER TABLE "Invoice" ADD COLUMN "orderReference" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "buyerReference" TEXT;
