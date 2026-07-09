-- Tier 52: Skonto (cash discount) on customer invoices.
--
-- Adds two optional columns to Invoice:
--   skontoPercent   Decimal(5,2)  e.g. 2.00 for 2%
--   skontoDays      Integer       e.g. 14 for "14 Tage"
--
-- Together they implement the B2B "Zahlbar bis DD.MM.
-- mit X% Skonto, bis DD.MM. ohne Abzug" line on the
-- invoice. The invoice-dueDate is the WITHOUT-Skonto
-- deadline; skontoDays counts BACKWARDS from there to
-- compute the WITH-Skonto deadline (issueDate + skontoDays).
--
-- Example: invoice issued 2026-07-01, dueDate 2026-07-28,
-- skontoDays=14 → Skonto window expires 2026-07-15. A
-- payment landing between 2026-07-01 and 2026-07-15 with
-- amount = total × (1 - skontoPercent) triggers a
-- Skonto-Buchung (Erlösminderung 8730 in SKR03).
--
-- Both columns NULL means "no Skonto" — backward compat
-- with the existing ~1.000 invoice rows.
ALTER TABLE "Invoice"
    ADD COLUMN "skontoPercent" DECIMAL(5,2),
    ADD COLUMN "skontoDays" INTEGER;
