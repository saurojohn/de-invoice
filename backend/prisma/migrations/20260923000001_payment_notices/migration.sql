-- Tier 430: a payment the customer reports is a notice to the company, not a
-- booked payment.
CREATE TABLE "PaymentNotice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,4) NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'open',
    "paymentId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    CONSTRAINT "PaymentNotice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentNotice_paymentId_key" ON "PaymentNotice"("paymentId");
CREATE INDEX "PaymentNotice_companyId_status_idx" ON "PaymentNotice"("companyId", "status");
CREATE INDEX "PaymentNotice_invoiceId_idx" ON "PaymentNotice"("invoiceId");
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
