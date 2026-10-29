-- Tier 736: the e-mail address of an account is confirmed by a link sent to
-- it. Until then the installation's mail server sends nothing for the
-- company (mail.service.ts). Existing accounts stay unconfirmed: nobody has
-- clicked a link for them; the dashboard asks for it.
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "emailVerifyTokenHash" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerifyExpires" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_emailVerifyTokenHash_key" ON "User"("emailVerifyTokenHash");
