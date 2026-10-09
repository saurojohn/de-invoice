-- Tier 635: the five tables that are filtered by company and had no index leading with it
CREATE INDEX "User_companyId_idx" ON "User"("companyId");
CREATE INDEX "WebhookDelivery_companyId_attemptedAt_idx" ON "WebhookDelivery"("companyId", "attemptedAt");
CREATE INDEX "VatRate_companyId_idx" ON "VatRate"("companyId");
CREATE INDEX "VatRateHistory_companyId_changedAt_idx" ON "VatRateHistory"("companyId", "changedAt");
CREATE INDEX "CustomerPortalSession_companyId_idx" ON "CustomerPortalSession"("companyId");
