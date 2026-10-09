-- Tier 616: projects below the customer, a default hourly rate per customer
-- Tier 617: a running timer per user
ALTER TABLE "Customer" ADD COLUMN "defaultHourlyRate" DECIMAL(12,2);

CREATE TABLE "TimeProject" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "hourlyRate" DECIMAL(12,2),
    "budgetHours" DECIMAL(10,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeProject_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimeProject_companyId_customerId_idx" ON "TimeProject"("companyId", "customerId");
ALTER TABLE "TimeProject" ADD CONSTRAINT "TimeProject_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeProject" ADD CONSTRAINT "TimeProject_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeEntry" ADD COLUMN "projectId" TEXT;
CREATE INDEX "TimeEntry_projectId_idx" ON "TimeEntry"("projectId");
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "TimeProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RunningTimer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerId" TEXT,
    "projectId" TEXT,
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "RunningTimer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RunningTimer_companyId_userId_key" ON "RunningTimer"("companyId", "userId");
ALTER TABLE "RunningTimer" ADD CONSTRAINT "RunningTimer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
