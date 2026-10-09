-- Tier 610: quotes (QU) and delivery notes (DN) are documents in "Invoice";
-- sourceDocumentId links a document to the one it was made from.
ALTER TABLE "Invoice" ADD COLUMN "sourceDocumentId" TEXT;
CREATE INDEX "Invoice_sourceDocumentId_idx" ON "Invoice"("sourceDocumentId");
