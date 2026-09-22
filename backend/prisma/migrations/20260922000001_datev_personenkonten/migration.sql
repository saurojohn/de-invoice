-- Tier 423: DATEV Personenkonten. Each customer gets a Debitor account
-- (10000–69999), each supplier a Kreditor account (70001–99999), assigned on
-- the first DATEV export and kept stable across exports.
ALTER TABLE "Customer" ADD COLUMN "datevAccount" INTEGER;
ALTER TABLE "Supplier" ADD COLUMN "datevAccount" INTEGER;
CREATE UNIQUE INDEX "Customer_companyId_datevAccount_key" ON "Customer"("companyId", "datevAccount");
CREATE UNIQUE INDEX "Supplier_companyId_datevAccount_key" ON "Supplier"("companyId", "datevAccount");
