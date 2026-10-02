-- Tier 502: private use of a company car (1 % rule, § 6 Abs. 1 Nr. 4 EStG;
-- unentgeltliche Wertabgabe, § 3 Abs. 9a UStG).
CREATE TABLE "CompanyCar" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "listPrice" DECIMAL(12,2) NOT NULL,
  "method" TEXT NOT NULL,
  "fromDate" DATE NOT NULL,
  "untilDate" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompanyCar_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CompanyCar_companyId_idx" ON "CompanyCar"("companyId");
ALTER TABLE "CompanyCar" ADD CONSTRAINT "CompanyCar_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
