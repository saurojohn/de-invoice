-- Migration: Tier 33 — Customer self-service portal (Kundenportal)
--
-- Why this migration:
--   The Tier 32 bulk-send got the invoice INTO the
--   customer's mailbox. Now we want the customer to
--   have a public, self-service view where they can
--   see the invoice + mark it as paid (mock payment —
--   real Stripe/Mollie wire-in is a separate ticket).
--
-- Why a standalone PaymentLink table (not a column
-- on Invoice):
--   1. Multiple links per invoice (regenerate + revoke)
--      — flat list is cleaner than a JSON array column.
--   2. Per-link expiry + per-link usage tracking
--      ("first time they hit it" vs "marked paid at").
--   3. Token rotation is easy (revoke old link + create
--      new one) without touching the Invoice row itself.
--
-- Why CASCADE:
--   When the parent Invoice is deleted (rare — usually
--   the invoice is voided via CN/RCV, not deleted), the
--   payment links die too. The cascading delete lives on
--   the FK, not the optional Model so PG handles the
--   order automatically.
--
-- Fields:
--   token        — 32-byte hex (crypto.randomBytes(16))
--                  The portal route is /portal/:token.
--                  No timing-safe comparison needed — PG
--                  btree index makes the lookup O(1) and
--                  the token has 128 bits of entropy so
--                  brute force is out of reach.
--   expiresAt    — default +30 days. The portal route
--                  returns 404 once expired. Long enough
--                  for typical Netto/30 payment terms,
--                  short enough that dead links don't
--                  accumulate forever.
--   revokedAt    — admin explicit revoke. Reissue path
--                  creates a new row instead of reactivating
--                  an old one — keeps the audit log clean.
--   usedAt       — set by mark-paid. PaymentLink is
--                  single-use for mark-paid (the link
--                  expires on first successful payment).
--   ipList       — cumulative access log. The portal
--                  route pushes the IP on every fetch.
--                  Helps the admin spot link leaks (a
--                  token surfacing from an unusual IP).
--   createdAt    — for the audit trail. The frontend
--                  shows "Link erstellt am …" to the customer.

CREATE TABLE "PaymentLink" (
  "id"        TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "token"     TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

-- Unique token: each token is a single-use portal URL.
-- PG's btree on token already enforces uniqueness,
-- adding the explicit UNIQUE for clarity + so future
-- ALTER TABLE migrations don't accidentally drop the
-- index.
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_token_key" UNIQUE ("token");

-- FK to Invoice. ON DELETE CASCADE so deleted invoices
-- don't leave dangling PaymentLink rows. (Though we
-- typically soft-void an invoice via a Gutschrift /
-- Cancellation-type row, not delete — see the void
-- flow on the Invoice controller.)
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_invoiceId_fkey"
  FOREIGN KEY ("invoiceId")
  REFERENCES "Invoice"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- Lookup-by-invoice for "list all links for this invoice"
-- (admin view — not built yet but the index is cheap).
CREATE INDEX "PaymentLink_invoiceId_idx" ON "PaymentLink"("invoiceId");

-- Lookup-by-token is already covered by the UNIQUE
-- constraint above (which implies a btree index). No
-- additional index needed for the GET /portal/:token
-- path.