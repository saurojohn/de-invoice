-- Tier 48: Cost-Center Budget.
--
-- Adds a per-(company, costCenter, year) row carrying
-- 12 monthly target amounts. The yearly report
-- (tier-44) and the new budget-vs-actual report join
-- these to render deltas. NULL costCenter maps to the
-- "Nicht zugewiesen" pseudo-bucket (same convention as
-- Invoice/Expense/VoucherLine).
--
-- monthlyTargets is JSON instead of a separate
-- BudgetLine table — the array is always read as a
-- unit, 12 floats is ~250 bytes, and the per-month
-- deltas are computed in the controller not the DB.
--
-- @@unique([companyId, costCenter, year]) supports the
-- upsert pattern in the controller (POST replaces if
-- the same triple exists).
CREATE TABLE "CostCenterBudget" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "costCenter" TEXT,
    "year" INTEGER NOT NULL,
    "monthlyTargets" JSONB NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostCenterBudget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CostCenterBudget_companyId_costCenter_year_key"
    ON "CostCenterBudget"("companyId", "costCenter", "year");

CREATE INDEX "CostCenterBudget_companyId_year_idx"
    ON "CostCenterBudget"("companyId", "year");

ALTER TABLE "CostCenterBudget"
    ADD CONSTRAINT "CostCenterBudget_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;