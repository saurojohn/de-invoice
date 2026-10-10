-- Tier 652: where an invoice's exchange rate is from ('ecb:YYYY-MM-DD' or 'manual').
ALTER TABLE "Invoice" ADD COLUMN "exchangeRateSource" TEXT;
