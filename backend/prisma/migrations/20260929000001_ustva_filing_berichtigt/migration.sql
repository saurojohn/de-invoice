-- Tier 465: a corrected return (§ 153 AO) is a flag of the filing, written as
-- Kz 10 into the ELSTER export. Tier 448 kept it only as a notes prefix.
ALTER TABLE "UStvaFiling" ADD COLUMN "berichtigt" BOOLEAN NOT NULL DEFAULT false;
UPDATE "UStvaFiling" SET "berichtigt" = true WHERE "notes" LIKE 'Berichtigte Voranmeldung%';
