-- Migration: Tier 174 — Postgres SEQUENCE for invoice numbering
--
-- Why this migration:
--   Tier 172's k6 load test exposed a real production
--   race: the service did `findMany` to get MAX(sequenceNumber),
--   picked nextSeq in JS, then `.create()`. Two concurrent
--   creates both picked the same nextSeq, the second
--   500'd with Prisma P2002 on @@unique([companyId, invoiceNumber]).
--
--   Tier 172's "fix" was retry+jitter+sleep — better than
--   nothing but still a JS-side guess. The proper fix is
--   a Postgres SEQUENCE: `nextval()` is atomic, two
--   concurrent transactions get different values, no
--   retry needed.
--
-- Scope:
--   - One SEQUENCE per (type, year) tuple, e.g.
--     `invoice_seq_INV_2026`, `invoice_seq_CN_2026`.
--   - Shared across all companies: the
--     @@unique([companyId, invoiceNumber]) constraint
--     already handles per-company isolation downstream.
--     Two different companies can both get `INV-2026-000042`
--     — that's already the current behavior, not a regression.
--   - Sequence is auto-created on first use of a
--     (type, year) tuple via the
--     CREATE SEQUENCE IF NOT EXISTS in
--     invoice.service.ts.nextInvoiceNumber() and
--     recurring.service.ts. This migration only seeds
--     sequences for (type, year) tuples that already
--     have data, so nextval() doesn't restart from 1
--     on existing data.
--
-- Why not a single global sequence:
--   The user-facing format `INV-2026-000203` includes the
--   year, and customers expect per-year numbering. A
--   global sequence would break that. Per-(type, year) is
--   the minimum to preserve the format while still being
--   fully atomic.
--
-- Why no DO block:
--   Prisma's $queryRawUnsafe runs a pre-flight table
--   existence check on identifiers it can extract from
--   the SQL text. A DO $$ ... format('%I', ...) ... $$
--   block has dynamic sequence names that Prisma's
--   parser picks up as table references (lowercased
--   to "invoice_seq_inv_2026"), so the check fails
--   even when the DO block would otherwise work fine.
--   We avoid this by hard-coding the (type, year)
--   tuples that exist at migration time. New (type,
--   year) tuples created later are handled by the
--   CREATE SEQUENCE IF NOT EXISTS in the service code
--   (idempotent, runs on every create).

-- (type=INV, year=2026): the only tuple in production at the
-- time of this migration. New tuples are auto-created by
-- the service.
CREATE SEQUENCE IF NOT EXISTS "invoice_seq_INV_2026" START 1 INCREMENT 1;

-- Seed: next nextval() should return MAX(existing seq)+1.
--
-- IMPORTANT: we extract the sequence from the
-- `invoiceNumber` string (e.g. 'INV-2026-000207' → 207),
-- NOT from the `sequenceNumber` column. The two diverge
-- for two reasons:
--   1. Pre-Tier-174 invoices have `sequenceNumber = null`
--      (the column was added in a later migration but
--      wasn't populated by the old service code).
--   2. The Tier 172 k6 load test created ~6000 invoices
--      with `sequenceNumber = null` and invoiceNumbers
--      like INV-2026-006204. Reading MAX(sequenceNumber)
--      would return the much smaller value from the
--      manually-seeded pre-Tier-174 rows (206), causing
--      the new sequence to start at 207 — which collides
--      with the k6-generated rows and produces P2002 on
--      every create.
--
-- Reading MAX(CAST(SUBSTRING(invoiceNumber FROM ...) AS INTEGER))
-- captures the real highest allocated number regardless of
-- whether `sequenceNumber` is populated. Safe even if some
-- rows have non-numeric suffixes (the regex filter rejects
-- them) — CAST fails cleanly and we fall through to 0.
--
-- setval(seq, n, true) → next nextval returns n+1.
SELECT setval(
  'invoice_seq_inv_2026',
  COALESCE(
    (
      SELECT MAX(CAST(SUBSTRING("invoiceNumber" FROM 'INV-2026-([0-9]+)$') AS INTEGER))
      FROM "Invoice"
      WHERE "invoiceNumber" ~ '^INV-2026-[0-9]+$'
        AND type = 'INV'
    ),
    0
  )::bigint,
  true
);
