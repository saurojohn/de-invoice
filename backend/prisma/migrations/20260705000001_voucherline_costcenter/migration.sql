-- Migration: Tier 41 — DATEV cost-center stamps on VoucherLine.
--
-- Why this migration:
--   Tier 26 shipped "Sachkonten auto-inference": the UI
--   picks the right account number after the user types a
--   description. Tier 41 takes the next step: once the
--   account is picked, suggest the most-used Kostenstelle
--   (costCenter) for that account, so the user doesn't
--   have to retype it on every similar booking.
--
-- Why per-VoucherLine (not per-Voucher):
--   Real-world bookings sometimes split: one Voucher can
--   carry one line on Sachkonto 4400 with Kostenstelle A
--   and another line on Sachkonto 4400 with Kostenstelle B
--   (multi-cost-center split per voucher). Mirroring the
--   Invoice.costCenter semantics — also per-row.
--
-- Why free-form string (not FK):
--   Same reasoning as Invoice.costCenter / Expense.costCenter
--   — DATEV imports commonly carry ad-hoc codes the user
--   hasn't predfined, and the column is read straight into
--   the DATEV ASCII export without a lookup.
--
-- Index on (accountId, costCenter):
--   Tier 41's primary query is:
--     SELECT costCenter, COUNT(*) AS c
--     FROM "VoucherLine"
--     WHERE accountId = $1 AND costCenter IS NOT NULL
--     GROUP BY costCenter
--     ORDER BY c DESC
--     LIMIT 1
--   The composite index lets PG filter to the small set of
--   rows for the account, then do an index-only GROUP BY
--   on costCenter — fast even on 100k+ Vouchers.

ALTER TABLE "VoucherLine"
  ADD COLUMN "costCenter" TEXT,
  ADD COLUMN "costObject" TEXT;

-- Backfill from Voucher → ... wait, Voucher has no
-- costCenter column either. The only way cost centers
-- landed on Buchungsstapel rows before Tier 41 was via
-- the Invoice / Expense routes (Tier 38/39 wired those).
-- Auto-generated Vouchers from invoices carry the
-- cost-center on the booking object (handled at the
-- application layer in datev.service.ts, NOT on a model
-- column). So no backfill is possible here — old rows
-- just have NULL costCenter, which is the correct
-- Tier-37 behaviour for them.

CREATE INDEX "VoucherLine_accountId_costCenter_idx"
  ON "VoucherLine"("accountId", "costCenter");
