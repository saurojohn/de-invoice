-- Tier 79: Berater Document Exchange.
--
-- The Steuerberater (UserCompany.role='berater')
-- needs a write-back channel to the Mandant.
-- Tier 66 gave them read access; tier 71 made
-- it explicit. This migration adds the data
-- model for the counterpart: a Berater can
-- create a note (free-form text + optional
-- attachment) on a specific record (an
-- invoice, an expense, a voucher, etc.) and
-- the Mandant sees it in a queue and can
-- acknowledge or dismiss.
--
-- The Berater does NOT get write access to
-- the underlying bookkeeping data — only to
-- this dedicated "berater" namespace. The
-- controller enforces the role='berater'
-- check on POST; we don't put that in the
-- schema because the role lives on
-- UserCompany, not User.
--
-- Lifecycle:
--   open → acknowledged | dismissed
--   The BeraterNote row is never hard-deleted
--   (audit trail; the Berater can see "yep,
--   the Mandant saw it and chose not to act").

CREATE TABLE "BeraterNote" (
    "id"            TEXT NOT NULL,
    "companyId"     TEXT NOT NULL,
    "entityType"    TEXT NOT NULL,
    "entityId"      TEXT NOT NULL,
    "attachmentId"  TEXT,
    "message"       TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'open',
    "createdById"   TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedById" TEXT,
    "acknowledgedAt"   TIMESTAMP(3),
    "dismissedById"    TEXT,
    "dismissedAt"      TIMESTAMP(3),

    CONSTRAINT "BeraterNote_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "BeraterNote"
    ADD CONSTRAINT "BeraterNote_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BeraterNote"
    ADD CONSTRAINT "BeraterNote_attachmentId_fkey"
    FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BeraterNote"
    ADD CONSTRAINT "BeraterNote_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BeraterNote"
    ADD CONSTRAINT "BeraterNote_acknowledgedById_fkey"
    FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BeraterNote"
    ADD CONSTRAINT "BeraterNote_dismissedById_fkey"
    FOREIGN KEY ("dismissedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes (match the schema.prisma @@index declarations).
-- (companyId, status, createdAt) is the dashboard
-- queue query — "all open notes for this company,
-- newest first". (entityType, entityId) is the
-- "show me the notes about this invoice" drill-in.
-- (createdById, createdAt) is the "my sent notes"
-- view for the Berater themselves.
CREATE INDEX "BeraterNote_companyId_status_createdAt_idx"
    ON "BeraterNote"("companyId", "status", "createdAt");
CREATE INDEX "BeraterNote_entityType_entityId_idx"
    ON "BeraterNote"("entityType", "entityId");
CREATE INDEX "BeraterNote_createdById_createdAt_idx"
    ON "BeraterNote"("createdById", "createdAt");
