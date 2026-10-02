-- Tier 500: the Mahnungspause an installment plan sets (Tier 64 / 429) is
-- linked to it; the plan itself now decides about dunning (kept → no
-- reminder, broken → dunned again), so a linked pause is not counted.
ALTER TABLE "Mahnungspause" ADD COLUMN "installmentPlanId" TEXT;
CREATE INDEX "Mahnungspause_installmentPlanId_idx" ON "Mahnungspause"("installmentPlanId");
-- Existing pauses of a plan: same invoice, open-ended, created with it.
UPDATE "Mahnungspause" m SET "installmentPlanId" = p.id
  FROM "InstallmentPlan" p
  WHERE m."invoiceId" = p."invoiceId" AND m."customerId" IS NULL AND m."pausedUntil" IS NULL
    AND m."installmentPlanId" IS NULL
    AND abs(extract(epoch from (m."createdAt" - p."createdAt"))) < 60;
