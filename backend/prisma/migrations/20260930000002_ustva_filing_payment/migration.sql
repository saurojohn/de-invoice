-- Tier 483: the payment to / refund from the Finanzamt that settled a UStVA
-- (Anlage EÜR Zeilen 18 / 58).
ALTER TABLE "UStvaFiling" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "UStvaFiling" ADD COLUMN "paidAmount" DECIMAL(12,2);
