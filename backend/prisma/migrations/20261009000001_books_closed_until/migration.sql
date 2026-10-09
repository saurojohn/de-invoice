-- Tier 609: closing of the books (Festschreibung). Documents and vouchers dated
-- on or before this day can no longer be written, changed or deleted.
ALTER TABLE "Company" ADD COLUMN "booksClosedUntil" DATE;
