-- Tier 367: a monotonic chain order for the audit log.
--
-- The hash chain was written and verified by (createdAt, id). createdAt is
-- rounded to whole seconds by the writer and id is a random UUID, so the
-- writer's max(createdAt, id) and the verify walk's ascending order disagreed
-- about which row came last within a second, and concurrent writers all read
-- the same predecessor. "seq" gives both sides one order that cannot tie.
--
-- Written as ADD COLUMN (nullable) -> backfill -> attach sequence -> SET NOT
-- NULL so it also applies to a database that already holds audit rows: the
-- backfill preserves the order the chain used to be walked in, which is the
-- order those rows' previousHash pointers were computed against.

ALTER TABLE "AuditLog" ADD COLUMN "seq" BIGINT;

WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "AuditLog"
)
UPDATE "AuditLog" a
SET "seq" = o.rn
FROM ordered o
WHERE a.id = o.id;

CREATE SEQUENCE "AuditLog_seq_seq" AS BIGINT OWNED BY "AuditLog"."seq";
SELECT setval('"AuditLog_seq_seq"', COALESCE((SELECT MAX("seq") FROM "AuditLog"), 0) + 1, false);
ALTER TABLE "AuditLog" ALTER COLUMN "seq" SET DEFAULT nextval('"AuditLog_seq_seq"');
ALTER TABLE "AuditLog" ALTER COLUMN "seq" SET NOT NULL;

CREATE UNIQUE INDEX "AuditLog_seq_key" ON "AuditLog"("seq");
CREATE INDEX "AuditLog_companyId_seq_idx" ON "AuditLog"("companyId", "seq");
