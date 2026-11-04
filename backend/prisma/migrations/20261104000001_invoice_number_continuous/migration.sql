-- Tier 793: a company's numbers continue over the years (one range per
-- document type) unless it chooses a new range each year. Both are allowed
-- (§ 14 Abs. 4 Satz 1 Nr. 4 UStG, UStAE 14.5 Abs. 10 and 11): the number must
-- be unique, not restart.
ALTER TABLE "Company" ADD COLUMN "invoiceNumberContinuous" BOOLEAN NOT NULL DEFAULT true;
