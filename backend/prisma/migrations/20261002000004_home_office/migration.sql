-- Tier 504: the home office of a sole trader / partner (§ 4 Abs. 5 Nr. 6b /
-- 6c EStG): per year either the Tagespauschale or the Jahrespauschale.
CREATE TABLE "HomeOffice" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "days" INTEGER,
  "months" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HomeOffice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HomeOffice_companyId_year_key" ON "HomeOffice"("companyId", "year");
ALTER TABLE "HomeOffice" ADD CONSTRAINT "HomeOffice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
