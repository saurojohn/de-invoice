-- Tier 842: the Kleinunternehmerregelung by date (common/kleinunternehmer-period.ts)
ALTER TABLE "Company" ADD COLUMN "kleinunternehmerAb" DATE;
ALTER TABLE "Company" ADD COLUMN "kleinunternehmerBis" DATE;
