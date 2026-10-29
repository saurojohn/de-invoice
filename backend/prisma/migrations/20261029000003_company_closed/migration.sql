-- Tier 737: a company closed with the account of its only member. Nobody can
-- sign in to it, nothing runs for it; its records are kept until
-- retentionUntil (31.12. of the tenth year after the closing, § 147 AO,
-- § 257 HGB). closedById is a snapshot like AuditLog.userId (the account is
-- anonymised, not deleted).
ALTER TABLE "Company" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "closedById" TEXT;
ALTER TABLE "Company" ADD COLUMN "retentionUntil" TIMESTAMP(3);
