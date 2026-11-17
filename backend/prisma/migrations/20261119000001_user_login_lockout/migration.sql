-- Tier 860: failed logins per account (see schema.prisma)
ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "failedLoginFirstAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "loginLockedUntil" TIMESTAMP(3);
