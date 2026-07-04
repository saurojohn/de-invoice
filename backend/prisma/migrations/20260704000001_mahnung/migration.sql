-- Migration: Tier 37 — Mahnung multi-level flow
-- (audit trail table, late-interest fields, soft-cancel).
--
-- Why a new table (Mahnung) when EmailSend already
-- records reminder sends:
--   1. The EmailSend table is multi-purpose (it holds
--      invoice, statement, bulk-send, and reminder rows).
--      Doing `WHERE templateType LIKE 'reminder_%'` to
--      count Mahnungen is awkward and slow.
--   2. We want to charge Mahngebühr + Verzugszins on the
--      Mahnung PDF, and store those numbers at send-time
--      — they're financial data and don't belong on a
--      generic email log.
--   3. The dashboard widget "Top overdue invoices with
--      dunning timeline" needs a flat list of Mahnungen
--      per invoice — JOINs into EmailSend + parse the
--      templateType become brittle.
--
-- Why Decimal(12,4):
--   Same precision as Invoice (and the migration tool
--   compares types when adding FKs). 4 decimal places
--   handle any minor rounding on the Verzugszins (= gross
--   total * pct/100 * days/365) without rounding error
--   that would show up on the Mahnung PDF.
--
-- Soft-cancel (cancelledAt) instead of hard-delete:
--   Mahnungen are financial records (the PDF was sent to
--   the customer, who may reply to it) — there is no
--   "un-ring this bell". A user / admin can cancel a
--   Mahnung that was sent in error or that was followed
--   up by an immediate payment, but the row stays for the
--   GoBD audit trail.
--
-- FK + CASCADE:
--   - Company CASCADE: deleting a company nukes everything
--   - Invoice CASCADE: deleting an invoice (rare — usually
--     voided via Gutschrift) nukes its Mahnungen.
--     PaymentService that promotes an invoice to 'paid'
--     does NOT delete Mahnungen, just cancels them.
--
-- Indexes:
--   - (companyId, invoiceId): the canonical "list of
--     Mahnungen for this invoice" query (dashboard + UI).
--   - (companyId, sentAt): all Mahnungen sorted by date
--     for the global Mahnhistorie page.
--   - (companyId, cancelledAt): partial queries for the
--     "open Mahnungen" pool used by auto-cron escalation
--     guards.

CREATE TABLE "Mahnung" (
  "id"              TEXT NOT NULL,
  "companyId"       TEXT NOT NULL,
  "invoiceId"       TEXT NOT NULL,
  "level"           TEXT NOT NULL,
  "daysOverdue"     INTEGER NOT NULL,
  "neueFrist"       TIMESTAMP(3) NOT NULL,
  "mahngebuehr"     DECIMAL(12,4) NOT NULL DEFAULT 0,
  "verzugszins"     DECIMAL(12,4) NOT NULL DEFAULT 0,
  "totalDue"        DECIMAL(12,4) NOT NULL,
  "recipientEmail"  TEXT NOT NULL,
  "recipientName"   TEXT,
  "sentById"        TEXT,
  "sentAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "emailSendId"     TEXT,
  "cancelledAt"     TIMESTAMP(3),
  "cancelledById"   TEXT,
  "cancelReason"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Mahnung_pkey" PRIMARY KEY ("id")
);

-- FK to Company. ON DELETE CASCADE so a deleted tenant
-- doesn't leave dangling dunning rows.
ALTER TABLE "Mahnung" ADD CONSTRAINT "Mahnung_companyId_fkey"
  FOREIGN KEY ("companyId")
  REFERENCES "Company"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- FK to Invoice. CASCADE for the same reason.
-- A Mahnung without an invoice is meaningless.
ALTER TABLE "Mahnung" ADD CONSTRAINT "Mahnung_invoiceId_fkey"
  FOREIGN KEY ("invoiceId")
  REFERENCES "Invoice"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

-- "List Mahnungen for this invoice" — used by the
-- dashboard widget + the Mahnhistorie page.
CREATE INDEX "Mahnung_companyId_invoiceId_idx"
  ON "Mahnung"("companyId", "invoiceId");

-- Date-ordered list (Mahnhistorie).
CREATE INDEX "Mahnung_companyId_sentAt_idx"
  ON "Mahnung"("companyId", "sentAt");

-- Partial queries on cancelled / open Mahnungen.
CREATE INDEX "Mahnung_companyId_cancelledAt_idx"
  ON "Mahnung"("companyId", "cancelledAt");

-- Level filter for "show me all `final` Mahnungen".
CREATE INDEX "Mahnung_level_idx" ON "Mahnung"("level");
