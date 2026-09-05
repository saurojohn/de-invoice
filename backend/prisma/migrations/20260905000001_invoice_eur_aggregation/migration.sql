-- Migration: Tier 304 fixup — Invoice EUR aggregation columns
--
-- Why this migration:
--   Tier 118 (2026-07-30, commit a38c67e) added
--   4 cross-currency aggregation columns to the
--   Invoice model:
--
--     - exchangeRate   (Decimal 12,6) — ECB rate vs EUR
--     - eurSubtotal    (Decimal 12,4) — pre-tax in EUR
--     - eurTotalVat    (Decimal 12,4) — USt in EUR
--     - eurTotal       (Decimal 12,4) — gross in EUR
--
--   The schema.prisma change shipped but the
--   ALTER TABLE migration was never written. The
--   dev DB has the columns from a manual ALTER
--   TABLE (backfilling 228 EUR rows with rate=1
--   and EUR=original), and the prod schema has
--   them too — but a fresh Hetzner deploy running
--   `prisma migrate deploy` from a clean DB
--   would NOT get them, because migrate deploy
--   replays the migration history and there's
--   no migration in that history.
--
--   This fixup migration:
--     1. Adds the 4 columns (idempotent: IF NOT
--        EXISTS, in case the dev DB was already
--        altered manually).
--     2. Backfills existing EUR rows (currency='EUR')
--        with rate=1.0000 and EUR=original. This
--        matches the Tier 118 backfill exactly.
--     3. Does NOT backfill non-EUR rows: Tier 118
--        shipped without an ECB rate cache for the
--        existing rows, so non-EUR rows in the
--        dev DB today either have EUR=original
--        (rate=1) or NULL. The Tier 118 code
--        path computes these on next update.
--
-- This is the Tier 304 "Invoice schema drift"
-- followup. The dev DB has been verified
-- (psql \d "Invoice" shows all 4 columns
-- with the correct types) so this is the prod
-- Hetzner-deploy-side catchup.

ALTER TABLE "Invoice"
  ADD COLUMN IF NOT EXISTS "exchangeRate" NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS "eurSubtotal"  NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS "eurTotalVat"  NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS "eurTotal"     NUMERIC(12,4);

-- Backfill: existing EUR rows where EUR columns
-- are still NULL (e.g. fresh prod DB). For EUR
-- the rate is 1 and EUR amounts = original.
UPDATE "Invoice"
SET
  "exchangeRate" = 1.000000,
  "eurSubtotal"  = "subtotal",
  "eurTotalVat"  = "totalVat",
  "eurTotal"     = "total"
WHERE
  "currency" = 'EUR'
  AND ("exchangeRate" IS NULL OR "eurSubtotal" IS NULL);
