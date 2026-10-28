-- Tier 733: numbers of issued documents that no invoice row carries — deleted
-- on their issue day, or lost in a restore. Never handed out again.
CREATE TABLE "RetiredInvoiceNumber" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "pdfPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "RetiredInvoiceNumber_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RetiredInvoiceNumber_companyId_invoiceNumber_key" ON "RetiredInvoiceNumber"("companyId", "invoiceNumber");
ALTER TABLE "RetiredInvoiceNumber" ADD CONSTRAINT "RetiredInvoiceNumber_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- the issued invoices deleted so far (the audit log names them)
INSERT INTO "RetiredInvoiceNumber" ("id", "companyId", "invoiceNumber", "reason", "createdAt")
SELECT gen_random_uuid()::text, a."companyId", a."oldData"->>'invoiceNumber', 'deleted', MIN(a."createdAt")
FROM "AuditLog" a
JOIN "Company" c ON c."id" = a."companyId"
WHERE a."action" = 'invoice.deleted'
  AND a."oldData"->>'status' IS DISTINCT FROM 'draft'
  AND a."oldData"->>'invoiceNumber' IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i."companyId" = a."companyId" AND i."invoiceNumber" = a."oldData"->>'invoiceNumber')
GROUP BY a."companyId", a."oldData"->>'invoiceNumber'
ON CONFLICT ("companyId", "invoiceNumber") DO NOTHING;
