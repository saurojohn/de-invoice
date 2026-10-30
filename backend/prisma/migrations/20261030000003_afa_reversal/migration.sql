-- Tier 746: the AfA storno reverses a booking instead of deleting it. Both
-- rows carry afaReversedAt; the reversal names what it reverses.
ALTER TABLE "Expense" ADD COLUMN "afaReversedAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "reversesExpenseId" TEXT;
