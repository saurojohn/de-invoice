-- Tier 729: how the customer pays an invoice (invoice/payment-method.ts).
ALTER TABLE "Invoice" ADD COLUMN "paymentMethod" TEXT;
