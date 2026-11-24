-- Tier 986: the customer's Handelsregister- or Steuernummer (BT-47, EN 16931 BR-AE-02)
ALTER TABLE "Customer" ADD COLUMN "registrationId" TEXT;
