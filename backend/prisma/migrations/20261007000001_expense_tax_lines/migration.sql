-- Tier 581: the VAT lines of an expense with more than one rate (an invoice
-- with 19 % and 7 %). An expense without rows is the ordinary one-rate case.
CREATE TABLE "ExpenseTaxLine" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "vatRate" DECIMAL(5,4) NOT NULL,
    "netAmount" DECIMAL(12,4) NOT NULL,
    "vatAmount" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "ExpenseTaxLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExpenseTaxLine_expenseId_idx" ON "ExpenseTaxLine"("expenseId");

CREATE INDEX "ExpenseTaxLine_companyId_idx" ON "ExpenseTaxLine"("companyId");

ALTER TABLE "ExpenseTaxLine" ADD CONSTRAINT "ExpenseTaxLine_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;
