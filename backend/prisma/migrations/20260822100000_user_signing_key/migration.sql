-- Migration: Tier 246 — UserSigningKey (Berater per-user cert)
--
-- Why this migration:
--   Tier 72 shipped CompanySigningKey — one cert
--   per Company, used for all PDFs. Tier 246
--   extends this with a per-User cert so the
--   Berater (or any user) can sign PDFs with
--   their own personal key. The PDF carries
--   BOTH certs in the PKCS#7 chain when the
--   user signs (Berater adds their stamp on top
--   of the company auto-cert).
--
-- The CN for user certs is the User's display
-- name (e.g. "M. Sauter") so the PDF reader
-- shows the natural person, not the company.
--
-- The cert + private key live in a dedicated
-- table for the same DB-leak reason as
-- CompanySigningKey (Tier 208): a JSONB blob
-- would expose the per-user key for every user
-- at once on a single SELECT.

CREATE TABLE "UserSigningKey" (
  id           TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL UNIQUE,
  "user"       "User"   @relation("UserSigningKeyOwner", fields: ["userId"], references: [id], onDelete: Cascade),
  "certPem"    TEXT NOT NULL,
  "keyPem"     TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "commonName" TEXT NOT NULL,
  "rotatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL
);

CREATE INDEX "UserSigningKey_userId_idx" ON "UserSigningKey"("userId");
