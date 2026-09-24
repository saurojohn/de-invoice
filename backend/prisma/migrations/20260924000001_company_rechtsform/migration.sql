-- Tier 441: the company's legal form. KSt 1, the Berater packager and
-- Anlage AUS read a `rechtsform` that did not exist and assumed a GmbH.
ALTER TABLE "Company" ADD COLUMN "rechtsform" TEXT;
