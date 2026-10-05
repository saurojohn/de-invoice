-- Tier 517: the Tagesabschluss was unique on its date alone — across all
-- companies. Once one company had closed a day, no other could (P2002 → 500).
-- The key is the company and the day.
DROP INDEX "CashBookDailyClose_businessDate_key";
DROP INDEX "CashBookDailyClose_companyId_businessDate_idx";
CREATE UNIQUE INDEX "CashBookDailyClose_companyId_businessDate_key" ON "CashBookDailyClose"("companyId", "businessDate");
