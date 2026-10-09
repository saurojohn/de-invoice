-- Tier 615: a line of a converted document names the line it was taken from
ALTER TABLE "InvoiceItem" ADD COLUMN "sourceItemId" TEXT;
CREATE INDEX "InvoiceItem_sourceItemId_idx" ON "InvoiceItem"("sourceItemId");
