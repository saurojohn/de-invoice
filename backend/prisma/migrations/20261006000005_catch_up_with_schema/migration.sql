-- Tier 559 — the migrations catch up with the schema.
--
-- Fourteen tables and eleven columns existed only in schema.prisma: they had
-- been created with `prisma db push` and never written down as a migration.
-- A database built with `prisma migrate deploy` (the update path in
-- infra/prod/README.md) had no UserSession, Webhook, SEPA, CronHealth …
-- tables at all.
--
-- Every statement here is safe to run on a database that already has the
-- object (one that was created with `db push`): IF NOT EXISTS / IF EXISTS,
-- and guarded constraints. The search_tsv columns (migration
-- 20260701000001, raw SQL, unknown to the schema) are left alone.
--
-- The three foreign keys that are dropped are added again further down with
-- the schema's ON DELETE rule.

ALTER TABLE "Asset" DROP CONSTRAINT IF EXISTS "Asset_companyId_fkey";

ALTER TABLE "CustomerCreditTransaction" DROP CONSTRAINT IF EXISTS "CustomerCreditTransaction_customerId_fkey";

ALTER TABLE "VoucherLine" DROP CONSTRAINT IF EXISTS "VoucherLine_accountId_fkey";

DROP INDEX IF EXISTS "Installment_planId_idx";

ALTER TABLE "Asset" ALTER COLUMN "anschaffungsDatum" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "verkauftAm" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "hash" TEXT,
ADD COLUMN IF NOT EXISTS "hashAlgorithm" TEXT,
ADD COLUMN IF NOT EXISTS "previousHash" TEXT;

ALTER TABLE "CashBookDailyClose" ADD COLUMN IF NOT EXISTS "signatureAlgorithm" TEXT,
ADD COLUMN IF NOT EXISTS "signatureHash" TEXT,
ADD COLUMN IF NOT EXISTS "signatureTimestamp" TIMESTAMP(3);

ALTER TABLE "CustomerCreditTransaction" ALTER COLUMN "currency" SET DATA TYPE TEXT,
ALTER COLUMN "type" SET DATA TYPE TEXT,
ALTER COLUMN "referenceType" SET DATA TYPE TEXT;

ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "paidBySepaBatchId" TEXT;

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "collectedBySepaBatchId" TEXT;

ALTER TABLE "RecurringInvoice" ADD COLUMN IF NOT EXISTS "pausedUntil" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "sendEmail" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "UserSigningKey" DROP COLUMN IF EXISTS "updatedAt";

CREATE TABLE IF NOT EXISTS "InvoiceInternalNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceInternalNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomerInternalNote" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerInternalNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomerPortalSession" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdFromIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPortalSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Webhook" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "durationMs" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextRetryAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NoteTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SepaBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "xmlContent" TEXT NOT NULL,
    "paymentCount" INTEGER NOT NULL,
    "totalAmount" DECIMAL(14,4) NOT NULL,
    "debtorIban" TEXT NOT NULL,
    "debtorBic" TEXT,
    "debtorName" TEXT NOT NULL,
    "executionDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'generated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SepaBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SepaDirectDebitMandate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "mandateReference" TEXT NOT NULL,
    "dateOfSignature" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CORE',
    "iban" TEXT NOT NULL,
    "bic" TEXT,
    "debitorName" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SepaDirectDebitMandate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SepaDirectDebitCollection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "preNotificationSentAt" TIMESTAMP(3),
    "preNotificationDeadline" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pre_notified',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SepaDirectDebitCollection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SepaDirectDebitBatch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "xmlContent" TEXT NOT NULL,
    "collectionCount" INTEGER NOT NULL,
    "totalAmount" DECIMAL(14,4) NOT NULL,
    "creditorIban" TEXT NOT NULL,
    "creditorBic" TEXT,
    "creditorName" TEXT NOT NULL,
    "creditorIdentifier" TEXT NOT NULL,
    "executionDate" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CORE',
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'generated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SepaDirectDebitBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CronHealth" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "summary" TEXT,

    CONSTRAINT "CronHealth_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NotificationConfig" (
    "id" TEXT NOT NULL,
    "rateThresholdCount" INTEGER NOT NULL DEFAULT 5,
    "rateThresholdWindowMinutes" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,

    CONSTRAINT "NotificationConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CompanySigningKey" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "certPem" TEXT NOT NULL,
    "keyPem" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "commonName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanySigningKey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InvoiceInternalNote_companyId_invoiceId_createdAt_idx" ON "InvoiceInternalNote"("companyId", "invoiceId", "createdAt");

CREATE INDEX IF NOT EXISTS "CustomerInternalNote_companyId_customerId_createdAt_idx" ON "CustomerInternalNote"("companyId", "customerId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "UserSession_token_key" ON "UserSession"("token");

CREATE INDEX IF NOT EXISTS "UserSession_userId_idx" ON "UserSession"("userId");

CREATE INDEX IF NOT EXISTS "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerPortalSession_token_key" ON "CustomerPortalSession"("token");

CREATE INDEX IF NOT EXISTS "CustomerPortalSession_customerId_idx" ON "CustomerPortalSession"("customerId");

CREATE INDEX IF NOT EXISTS "CustomerPortalSession_expiresAt_idx" ON "CustomerPortalSession"("expiresAt");

CREATE INDEX IF NOT EXISTS "Webhook_companyId_status_idx" ON "Webhook"("companyId", "status");

CREATE INDEX IF NOT EXISTS "Webhook_createdAt_idx" ON "Webhook"("createdAt");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_webhookId_attemptedAt_idx" ON "WebhookDelivery"("webhookId", "attemptedAt");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_eventType_eventId_idx" ON "WebhookDelivery"("eventType", "eventId");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");

CREATE INDEX IF NOT EXISTS "NoteTemplate_companyId_sortOrder_idx" ON "NoteTemplate"("companyId", "sortOrder");

CREATE INDEX IF NOT EXISTS "SepaBatch_companyId_executionDate_idx" ON "SepaBatch"("companyId", "executionDate");

CREATE INDEX IF NOT EXISTS "SepaBatch_companyId_status_idx" ON "SepaBatch"("companyId", "status");

CREATE INDEX IF NOT EXISTS "SepaDirectDebitMandate_companyId_customerId_idx" ON "SepaDirectDebitMandate"("companyId", "customerId");

CREATE INDEX IF NOT EXISTS "SepaDirectDebitMandate_companyId_status_idx" ON "SepaDirectDebitMandate"("companyId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "SepaDirectDebitMandate_companyId_mandateReference_key" ON "SepaDirectDebitMandate"("companyId", "mandateReference");

CREATE UNIQUE INDEX IF NOT EXISTS "SepaDirectDebitCollection_invoiceId_key" ON "SepaDirectDebitCollection"("invoiceId");

CREATE INDEX IF NOT EXISTS "SepaDirectDebitCollection_companyId_batchId_idx" ON "SepaDirectDebitCollection"("companyId", "batchId");

CREATE INDEX IF NOT EXISTS "SepaDirectDebitCollection_companyId_mandateId_idx" ON "SepaDirectDebitCollection"("companyId", "mandateId");

CREATE INDEX IF NOT EXISTS "SepaDirectDebitCollection_status_idx" ON "SepaDirectDebitCollection"("status");

CREATE INDEX IF NOT EXISTS "SepaDirectDebitBatch_companyId_executionDate_idx" ON "SepaDirectDebitBatch"("companyId", "executionDate");

CREATE INDEX IF NOT EXISTS "SepaDirectDebitBatch_companyId_status_idx" ON "SepaDirectDebitBatch"("companyId", "status");

CREATE INDEX IF NOT EXISTS "SepaDirectDebitBatch_companyId_type_idx" ON "SepaDirectDebitBatch"("companyId", "type");

CREATE INDEX IF NOT EXISTS "CronHealth_name_startedAt_idx" ON "CronHealth"("name", "startedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "CompanySigningKey_companyId_key" ON "CompanySigningKey"("companyId");

-- an older migration made this index on other columns under the same name
DROP INDEX IF EXISTS "CustomerCreditTransaction_referenceId_idx";

CREATE INDEX "CustomerCreditTransaction_referenceId_idx" ON "CustomerCreditTransaction"("referenceId");

CREATE INDEX IF NOT EXISTS "Expense_companyId_paidAt_idx" ON "Expense"("companyId", "paidAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCreditTransaction_customerId_fkey') THEN
    ALTER TABLE "CustomerCreditTransaction" ADD CONSTRAINT "CustomerCreditTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Expense_paidBySepaBatchId_fkey') THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paidBySepaBatchId_fkey" FOREIGN KEY ("paidBySepaBatchId") REFERENCES "SepaBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Invoice_collectedBySepaBatchId_fkey') THEN
    ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_collectedBySepaBatchId_fkey" FOREIGN KEY ("collectedBySepaBatchId") REFERENCES "SepaDirectDebitBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceInternalNote_invoiceId_fkey') THEN
    ALTER TABLE "InvoiceInternalNote" ADD CONSTRAINT "InvoiceInternalNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerInternalNote_customerId_fkey') THEN
    ALTER TABLE "CustomerInternalNote" ADD CONSTRAINT "CustomerInternalNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserSession_userId_fkey') THEN
    ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerPortalSession_companyId_fkey') THEN
    ALTER TABLE "CustomerPortalSession" ADD CONSTRAINT "CustomerPortalSession_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerPortalSession_customerId_fkey') THEN
    ALTER TABLE "CustomerPortalSession" ADD CONSTRAINT "CustomerPortalSession_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VoucherLine_accountId_fkey') THEN
    ALTER TABLE "VoucherLine" ADD CONSTRAINT "VoucherLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Webhook_companyId_fkey') THEN
    ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Webhook_createdById_fkey') THEN
    ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WebhookDelivery_webhookId_fkey') THEN
    ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NoteTemplate_companyId_fkey') THEN
    ALTER TABLE "NoteTemplate" ADD CONSTRAINT "NoteTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Asset_companyId_fkey') THEN
    ALTER TABLE "Asset" ADD CONSTRAINT "Asset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SepaBatch_companyId_fkey') THEN
    ALTER TABLE "SepaBatch" ADD CONSTRAINT "SepaBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SepaDirectDebitMandate_companyId_fkey') THEN
    ALTER TABLE "SepaDirectDebitMandate" ADD CONSTRAINT "SepaDirectDebitMandate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SepaDirectDebitMandate_customerId_fkey') THEN
    ALTER TABLE "SepaDirectDebitMandate" ADD CONSTRAINT "SepaDirectDebitMandate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SepaDirectDebitCollection_companyId_fkey') THEN
    ALTER TABLE "SepaDirectDebitCollection" ADD CONSTRAINT "SepaDirectDebitCollection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SepaDirectDebitCollection_batchId_fkey') THEN
    ALTER TABLE "SepaDirectDebitCollection" ADD CONSTRAINT "SepaDirectDebitCollection_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SepaDirectDebitBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SepaDirectDebitCollection_mandateId_fkey') THEN
    ALTER TABLE "SepaDirectDebitCollection" ADD CONSTRAINT "SepaDirectDebitCollection_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "SepaDirectDebitMandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SepaDirectDebitCollection_invoiceId_fkey') THEN
    ALTER TABLE "SepaDirectDebitCollection" ADD CONSTRAINT "SepaDirectDebitCollection_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SepaDirectDebitBatch_companyId_fkey') THEN
    ALTER TABLE "SepaDirectDebitBatch" ADD CONSTRAINT "SepaDirectDebitBatch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CompanySigningKey_companyId_fkey') THEN
    ALTER TABLE "CompanySigningKey" ADD CONSTRAINT "CompanySigningKey_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserSigningKey_userId_fkey') THEN
    ALTER TABLE "UserSigningKey" ADD CONSTRAINT "UserSigningKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
