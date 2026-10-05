-- Tier 522: an invoice can have a new Ratenplan after one was cancelled or
-- completed. `invoiceId` was unique, so the cancelled plan blocked it for good.
DROP INDEX "InstallmentPlan_invoiceId_key";
CREATE INDEX "InstallmentPlan_invoiceId_idx" ON "InstallmentPlan"("invoiceId");
