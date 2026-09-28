-- Tier 464: how the company determines its profit — 'euer' (§ 4 Abs. 3 EStG,
-- payments) or 'bilanz' (§ 4 Abs. 1 / § 5 EStG, accrual). NULL = derived from
-- the legal form (company/gewinnermittlung.ts).
ALTER TABLE "Company" ADD COLUMN "gewinnermittlung" TEXT;
