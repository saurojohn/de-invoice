-- Tier 66: Multi-Mandanten-Berater (UserCompany join table).
--
-- Many-to-many between User and Company. Each row
-- grants a User access to a Company with a specific
-- role. The Berater (Steuerberater) typically has
-- one row per Mandant they manage; a single-Mandant
-- user has exactly one row.
--
-- The existing User.companyId stays as the "default
-- login Mandant" — the company the user lands on
-- after login. The actual access control moves
-- from User.companyId == x-company-id (which was
-- strict 1:1) to UserCompany-based lookup (which
-- is many-to-many).
--
-- Composite PK (userId, companyId). A user can
-- only have ONE role per company.
--
-- Backfill: every existing User.companyId is
-- migrated to a UserCompany row with role=User.role.
-- This preserves the current access semantics so
-- the migration is invisible to users.

CREATE TABLE "UserCompany" (
    "userId"      TEXT NOT NULL,
    "companyId"   TEXT NOT NULL,
    "role"        TEXT NOT NULL DEFAULT 'accountant',
    "grantedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedById" TEXT,

    CONSTRAINT "UserCompany_pkey" PRIMARY KEY ("userId","companyId")
);

-- Foreign keys
ALTER TABLE "UserCompany"
    ADD CONSTRAINT "UserCompany_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompany"
    ADD CONSTRAINT "UserCompany_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCompany"
    ADD CONSTRAINT "UserCompany_grantedById_fkey"
    FOREIGN KEY ("grantedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes (match the schema.prisma @@index declarations)
CREATE INDEX "UserCompany_userId_idx"
    ON "UserCompany"("userId");

CREATE INDEX "UserCompany_companyId_idx"
    ON "UserCompany"("companyId");

-- Backfill: copy existing User.companyId to UserCompany
-- with the user's current role. The grantedById is
-- left NULL — there's no historical "who granted
-- this access" record. The role is copied from
-- User.role so the per-company role starts as the
-- user's overall role.
--
-- The NOT NULL guard on User.companyId uses
-- `WHERE "companyId" IS NOT NULL` so users that
-- somehow have a NULL company (orphans) are skipped
-- (we don't insert a UserCompany with a NULL FK).
INSERT INTO "UserCompany" ("userId", "companyId", "role", "grantedAt")
SELECT
    id,
    "companyId",
    role,
    NOW()
FROM "User"
WHERE "companyId" IS NOT NULL
ON CONFLICT ("userId", "companyId") DO NOTHING;
