-- Tier 540: what a payment of a foreign-currency invoice brought in EUR — the
-- difference to the invoice's rate is the Kursgewinn / Kursverlust.
ALTER TABLE "Payment" ADD COLUMN "eurAmount" DECIMAL(12,2);
