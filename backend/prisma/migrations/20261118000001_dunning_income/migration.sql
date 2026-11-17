-- Tier 854: the Mahnkosten a payment settled (see schema.prisma)
CREATE TABLE "DunningIncome" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "mahnungId" TEXT,
    "date" DATE NOT NULL,
    "mahngebuehr" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "verzugszins" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DunningIncome_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DunningIncome_paymentId_key" ON "DunningIncome"("paymentId");
CREATE INDEX "DunningIncome_companyId_date_idx" ON "DunningIncome"("companyId", "date");
CREATE INDEX "DunningIncome_invoiceId_idx" ON "DunningIncome"("invoiceId");
ALTER TABLE "DunningIncome" ADD CONSTRAINT "DunningIncome_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DunningIncome" ADD CONSTRAINT "DunningIncome_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DunningIncome" ADD CONSTRAINT "DunningIncome_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
