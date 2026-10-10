-- Tier 649: does the company take part in the OSS scheme (§ 18j UStG)?
-- Decided by the owner on 10.10.2026. false: a sale to a consumer in another
-- member state at 19 % / 7 % is German tax (the 10 000 € threshold of § 3c
-- Abs. 4 UStG is not exceeded); true: every such sale is the other state's.
ALTER TABLE "Company" ADD COLUMN "ossVerfahren" BOOLEAN NOT NULL DEFAULT false;
