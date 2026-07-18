-- Tier 64: Mahnungspause (reminder pause).
--
-- Use cases:
--   - Customer is on an InstallmentPlan (Tier 51) — the
--     Ratenplan handles dunning; we shouldn't pile Mahnungen
--     on top. The Berater pauses the customer once and the
--     pause covers all the plan's invoices.
--   - Customer disputed the invoice and an out-of-band
--     resolution is in flight.
--   - Manual: the Berater knows the customer will pay
--     next week and wants to skip this week's Mahnung.
--
-- A pause is "active" when the current time is in
-- [pausedFrom, pausedUntil]. When `pausedUntil` is NULL,
-- the pause is open-ended — the Berater must close it
-- explicitly.
--
-- A pause targets either:
--   - a Customer (customerId set, invoiceId null) — every
--     invoice of that customer is excluded
--   - an Invoice (invoiceId set, customerId null) — that
--     specific invoice is excluded
-- Exactly one of {customerId, invoiceId} is non-null.
-- Both null or both set is a 400 in the service layer.
--
-- The reminder service filter uses the (companyId,
-- customerId) + (companyId, invoiceId) composite indexes
-- to do an O(1) `IN (...)` exclusion without a full scan.
--
-- `cancelledAt` is the soft-cancel stamp (GoBD: we
-- keep the row for audit even after the pause ends).

CREATE TABLE "Mahnungspause" (
    "id"          TEXT NOT NULL,
    "companyId"   TEXT NOT NULL,
    "customerId"  TEXT,
    "invoiceId"   TEXT,
    "reason"      TEXT NOT NULL,
    "pausedFrom"  TIMESTAMP(3) NOT NULL,
    "pausedUntil" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mahnungspause_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "Mahnungspause"
    ADD CONSTRAINT "Mahnungspause_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Mahnungspause"
    ADD CONSTRAINT "Mahnungspause_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Mahnungspause"
    ADD CONSTRAINT "Mahnungspause_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Mahnungspause"
    ADD CONSTRAINT "Mahnungspause_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes (match the schema.prisma @@index declarations)
CREATE INDEX "Mahnungspause_companyId_customerId_idx"
    ON "Mahnungspause"("companyId", "customerId");

CREATE INDEX "Mahnungspause_companyId_invoiceId_idx"
    ON "Mahnungspause"("companyId", "invoiceId");

CREATE INDEX "Mahnungspause_companyId_cancelledAt_idx"
    ON "Mahnungspause"("companyId", "cancelledAt");
