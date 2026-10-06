-- Tier 541: trips between home and the business with a company car
-- (§ 4 Abs. 5 Satz 1 Nr. 6 EStG): the one-way distance and the days per month.
ALTER TABLE "CompanyCar" ADD COLUMN "commuteKm" INTEGER;
ALTER TABLE "CompanyCar" ADD COLUMN "commuteDays" INTEGER;
