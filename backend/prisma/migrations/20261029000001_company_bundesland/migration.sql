-- Tier 734: the Land of the company's Finanzamt — needed to write the
-- Steuernummer in ELSTER's 13-digit form (common/steuernummer.ts).
ALTER TABLE "Company" ADD COLUMN "bundesland" TEXT;
