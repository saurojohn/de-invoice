-- Tier 729c: the company's own template chosen for an invoice (NULL = the default).
ALTER TABLE "Invoice" ADD COLUMN "templateId" TEXT;
