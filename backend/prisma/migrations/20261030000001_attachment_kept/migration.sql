-- Tier 740: a Beleg is not deleted. Taking one off an open record marks it
-- (deletedAt, deletedById); row and bytes stay, the record no longer shows it.
-- keptOriginal: the received e-invoice as it came, which cannot be taken off.
ALTER TABLE "Attachment" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Attachment" ADD COLUMN "deletedById" TEXT;
ALTER TABLE "Attachment" ADD COLUMN "keptOriginal" BOOLEAN NOT NULL DEFAULT false;
