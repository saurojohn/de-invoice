-- Tier 472: a final invoice (Schlussrechnung) settles the advance paid on a
-- Proforma (§ 14 Abs. 5 UStG).
ALTER TABLE "Invoice" ADD COLUMN "advanceInvoiceId" TEXT;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_advanceInvoiceId_fkey"
  FOREIGN KEY ("advanceInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Invoice_advanceInvoiceId_idx" ON "Invoice"("advanceInvoiceId");
