-- Tier 26: VoucherLine.accountId becomes nullable.
--
-- Before this migration: accountId was NOT NULL,
-- which forced the UI to ask the user for an
-- SKR03 account on every VoucherLine they create.
-- Most users don't know the Kontenplan by heart,
-- so the Sachkonten auto-inference (see
-- datev-sachkonto-inference.ts) is the right
-- alternative. The line is created with
-- accountId = NULL; the inference service sets
-- it on first access. The user can also set
-- it manually in the UI (the account picker is
-- still there — just optional now).
--
-- We drop the NOT NULL constraint. Existing rows
-- are unaffected (their accountId stays). The
-- @@index([accountId]) is kept (NULL is a valid
-- index key in Postgres) so account lookups stay
-- fast.

ALTER TABLE "VoucherLine"
  ALTER COLUMN "accountId" DROP NOT NULL;