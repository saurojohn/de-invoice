-- Tier 425: a cash receipt for an invoice records a Payment; the entry keeps
-- its id so a Storno of the entry removes the payment again.
ALTER TABLE "CashBookEntry" ADD COLUMN "paymentId" TEXT;
CREATE UNIQUE INDEX "CashBookEntry_paymentId_key" ON "CashBookEntry"("paymentId");
ALTER TABLE "CashBookEntry" ADD CONSTRAINT "CashBookEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
