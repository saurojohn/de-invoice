-- Tier 493: Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG, BT-73/74) on an
-- invoice, and on a recurring template which period its invoices state.
ALTER TABLE "Invoice" ADD COLUMN "servicePeriodStart" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "servicePeriodEnd" TIMESTAMP(3);
ALTER TABLE "RecurringInvoice" ADD COLUMN "servicePeriod" TEXT NOT NULL DEFAULT 'none';
