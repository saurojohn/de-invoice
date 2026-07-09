-- Tier 51: Ratenzahlung (installment payment plans).
--
-- Adds two tables that together model a customer-
-- facing installment plan attached to a single
-- Invoice. The plan captures the agreed schedule
-- (N installments, day 1 due date, interval in days)
-- and the per-installment rows carry the per-Rate
-- payment status so the Berater can see at a glance
-- "what's still open" without scanning the bank-
-- import history.
--
-- Money invariants (enforced in the service):
--   sum(Installment.amount) == InstallmentPlan.totalAmount
--   0 <= Installment.paidAmount <= Installment.amount
--   partial pay = Installment.paidAmount < amount
--   paid = Installment.paidAmount == amount
--
-- One plan per Invoice (1:1). Cancelling or
-- completing the plan is a soft delete — we keep
-- the rows for the GoBD audit trail.
--
-- `intervalDays` defaults to 30 (monthly) but
-- supports weekly (7), bi-weekly (14), quarterly
-- (90), or any custom day count.
--
-- status on Installment is denormalised — it's
-- derived from paidAmount/dueDate but cached so
-- we can index/filter on it without re-computing
-- across N rows.

CREATE TABLE "InstallmentPlan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "totalAmount" DECIMAL(12,4) NOT NULL,
    "installmentCount" INTEGER NOT NULL,
    "intervalDays" INTEGER NOT NULL DEFAULT 30,
    "firstDueDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstallmentPlan_pkey" PRIMARY KEY ("id")
);

-- 1:1 with Invoice — one plan per invoice.
CREATE UNIQUE INDEX "InstallmentPlan_invoiceId_key"
    ON "InstallmentPlan"("invoiceId");

-- Filtering: all plans for a company (dashboard list).
CREATE INDEX "InstallmentPlan_companyId_status_idx"
    ON "InstallmentPlan"("companyId", "status");

-- Filtering: all open plans for a customer (statement).
CREATE INDEX "InstallmentPlan_customerId_status_idx"
    ON "InstallmentPlan"("customerId", "status");

ALTER TABLE "InstallmentPlan"
    ADD CONSTRAINT "InstallmentPlan_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InstallmentPlan"
    ADD CONSTRAINT "InstallmentPlan_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InstallmentPlan"
    ADD CONSTRAINT "InstallmentPlan_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "Installment" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "amount" DECIMAL(12,4) NOT NULL,
    "paidAmount" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Installment_pkey" PRIMARY KEY ("id")
);

-- 1:M with the plan.
CREATE INDEX "Installment_planId_idx"
    ON "Installment"("planId");

-- Filtering "all open installments" for dashboard
-- Mahnung integration — Tier 51 will integrate.
CREATE INDEX "Installment_status_dueDate_idx"
    ON "Installment"("status", "dueDate");

-- Sequence within a plan is unique (1, 2, 3, ...).
CREATE UNIQUE INDEX "Installment_planId_sequenceNumber_key"
    ON "Installment"("planId", "sequenceNumber");

ALTER TABLE "Installment"
    ADD CONSTRAINT "Installment_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "InstallmentPlan"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
