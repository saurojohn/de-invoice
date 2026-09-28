-- Tier 443: a booked supplier invoice is corrected by a Storno (a negative
-- counter-entry that points at it), not deleted.
ALTER TABLE "Expense" ADD COLUMN "stornoOfId" TEXT;
CREATE UNIQUE INDEX "Expense_stornoOfId_key" ON "Expense"("stornoOfId");
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_stornoOfId_fkey" FOREIGN KEY ("stornoOfId") REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
