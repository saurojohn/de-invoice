-- Tier 484: VAT paid to / refunded by the Finanzamt outside a UStVA
-- (UStJA Abschlusszahlung, Sondervorauszahlung, other).
CREATE TABLE "UstPayment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UstPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UstPayment_companyId_paidAt_idx" ON "UstPayment"("companyId", "paidAt");
ALTER TABLE "UstPayment" ADD CONSTRAINT "UstPayment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
