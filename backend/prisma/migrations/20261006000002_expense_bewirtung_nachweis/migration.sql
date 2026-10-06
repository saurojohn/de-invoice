-- Tier 539: the record a Bewirtung needs to be deductible (§ 4 Abs. 5 Nr. 2
-- Satz 2 EStG): the occasion and the participants.
ALTER TABLE "Expense" ADD COLUMN "bewirtungAnlass" TEXT;
ALTER TABLE "Expense" ADD COLUMN "bewirtungTeilnehmer" TEXT;
