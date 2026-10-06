-- Tier 537: a submitted UStVA locks its period; `releasedAt` is set when the
-- period is released for corrections (a corrected return locks it again).
ALTER TABLE "UStvaFiling" ADD COLUMN "releasedAt" TIMESTAMP(3);
