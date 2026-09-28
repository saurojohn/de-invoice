-- Tier 457: Soll- or Ist-Versteuerung (§ 20 UStG). NULL = 'soll' (as before).
ALTER TABLE "Company" ADD COLUMN "besteuerungsart" TEXT;
