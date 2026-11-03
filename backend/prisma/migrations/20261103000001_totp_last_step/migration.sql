-- Tier 786: the TOTP time step a user's code was last accepted for. A code
-- counts once: the next one must be for a later step.
ALTER TABLE "User" ADD COLUMN "twoFactorLastStep" INTEGER;
