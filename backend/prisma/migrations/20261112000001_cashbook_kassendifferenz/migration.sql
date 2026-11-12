-- Tier 838: the Tagesabschluss books a counted difference as an entry of its
-- own (Kassenfehlbetrag / Kassenüberschuss), so the Kassenbuch shows what is
-- in the till. Before, the difference was only noted on the close and the
-- book carried the phantom amount on to every later day.
ALTER TABLE "CashBookEntry" ADD COLUMN "kind" TEXT;
