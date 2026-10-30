-- Tier 744: the access of a tax auditor (role "auditor") ends on a day.
ALTER TABLE "UserCompany" ADD COLUMN "accessUntil" TIMESTAMP(3);
ALTER TABLE "UserInvitation" ADD COLUMN "accessUntil" TIMESTAMP(3);
