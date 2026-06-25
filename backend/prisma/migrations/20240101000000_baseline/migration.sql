-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "taxId" TEXT,
    "vatId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "fax" TEXT,
    "website" TEXT,
    "registerEntry" TEXT,
    "managingDirector" TEXT,
    "otherInfo" TEXT,
    "address" JSONB NOT NULL,
    "bankInfo" JSONB,
    "settings" JSONB,
    "logoPath" TEXT,
    "invoicePrefix" TEXT,
    "defaultPaymentDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "status" TEXT NOT NULL DEFAULT 'active',
    "profile" JSONB,
    "preferences" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLogin" TIMESTAMP(3),
    "passwordResetToken" TEXT,
    "passwordResetExpires" TIMESTAMP(3),
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "twoFactorConfirmedAt" TIMESTAMP(3),
    "recoveryCodes" JSONB,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserInvitation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'accountant',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'business',
    "name" TEXT NOT NULL,
    "customerNumber" TEXT,
    "vatId" TEXT,
    "taxExempt" BOOLEAN NOT NULL DEFAULT false,
    "address" JSONB NOT NULL,
    "contact" JSONB,
    "paymentTerms" INTEGER NOT NULL DEFAULT 30,
    "creditLimit" DECIMAL(12,2),
    "tags" TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "city_text" TEXT,
    "postal_code_text" TEXT,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vatId" TEXT,
    "address" JSONB NOT NULL,
    "contact" JSONB,
    "bankInfo" JSONB,
    "paymentTerms" INTEGER NOT NULL DEFAULT 30,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierId" TEXT,
    "invoiceNumber" TEXT,
    "description" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "netAmount" DECIMAL(12,4) NOT NULL,
    "vatRate" DECIMAL(5,4) NOT NULL,
    "vatAmount" DECIMAL(12,4) NOT NULL,
    "grossAmount" DECIMAL(12,4) NOT NULL,
    "category" TEXT,
    "isIntraEU" BOOLEAN NOT NULL DEFAULT false,
    "isReverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'booked',
    "notes" TEXT,
    "attachmentPath" TEXT,
    "costCenter" TEXT,
    "costObject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UStvaFiling" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "quarter" INTEGER,
    "month" INTEGER,
    "periodLabel" TEXT NOT NULL,
    "outputVat" DECIMAL(12,4) NOT NULL,
    "inputVat" DECIMAL(12,4) NOT NULL,
    "payableVat" DECIMAL(12,4) NOT NULL,
    "intraEUSales" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "intraEUPurchase" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submittedAt" TIMESTAMP(3),
    "taxNumber" TEXT,
    "notes" TEXT,
    "pdfPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UStvaFiling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "categoryId" TEXT,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'good',
    "unit" TEXT NOT NULL DEFAULT 'piece',
    "basePrice" DECIMAL(12,4) NOT NULL,
    "purchasePrice" DECIMAL(12,4),
    "vatRate" DECIMAL(5,4) NOT NULL DEFAULT 0.19,
    "stockQuantity" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "lowStockThreshold" DECIMAL(12,4),
    "trackInventory" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStockHistory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "previousQty" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "newQty" DECIMAL(12,4) NOT NULL,
    "reference" TEXT,
    "referenceType" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductStockHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "sequencePrefix" TEXT,
    "sequenceYear" INTEGER,
    "sequenceMonth" INTEGER,
    "sequenceNumber" INTEGER,
    "type" TEXT NOT NULL DEFAULT 'INV',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "issueDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "deliveryDate" TIMESTAMP(3),
    "subtotal" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "totalVat" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "discountPercent" DECIMAL(5,2),
    "discountAmount" DECIMAL(12,4),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "language" TEXT NOT NULL DEFAULT 'de-DE',
    "vatBreakdown" JSONB,
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "euTransaction" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "internalNotes" TEXT,
    "templateType" TEXT NOT NULL DEFAULT 'standard',
    "costCenter" TEXT,
    "costObject" TEXT,
    "pdfPath" TEXT,
    "attachments" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voucherRefId" TEXT,
    "referenceInvoiceId" TEXT,
    "recurringInvoiceId" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "productId" TEXT,
    "productNumber" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL DEFAULT 1,
    "unit" TEXT,
    "unitPrice" DECIMAL(12,4) NOT NULL,
    "vatRate" DECIMAL(5,4) NOT NULL DEFAULT 0.19,
    "netAmount" DECIMAL(12,4) NOT NULL,
    "vatAmount" DECIMAL(12,4) NOT NULL,
    "grossAmount" DECIMAL(12,4) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "receiptNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT,
    "parentId" TEXT,
    "isVatAccount" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "voucherNumber" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "referenceType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedById" TEXT,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherLine" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "description" TEXT,
    "debit" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "vatRate" DECIMAL(5,4),
    "vatAmount" DECIMAL(12,4),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VoucherLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VatRate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "countryCode" TEXT NOT NULL,
    "rate" DECIMAL(5,4) NOT NULL,
    "rateType" TEXT NOT NULL,
    "name" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VatRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VatRateHistory" (
    "id" TEXT NOT NULL,
    "vatRateId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "rate" DECIMAL(5,4) NOT NULL,
    "rateType" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeReason" TEXT,

    CONSTRAINT "VatRateHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VatValidationLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "vatId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "viesName" TEXT,
    "viesAddress" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "checkedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VatValidationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
    "smtpUser" TEXT NOT NULL,
    "smtpPassword" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "fromEmail" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSend" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "templateType" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "recipientName" TEXT,
    "subject" TEXT,
    "bodyPreview" TEXT,
    "attachmentPaths" JSONB,
    "status" TEXT NOT NULL DEFAULT 'opened',
    "sentAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "ocrText" TEXT,
    "contentHash" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "oldData" JSONB,
    "newData" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" JSONB,
    "kind" TEXT NOT NULL DEFAULT 'unhandled',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'open',
    "fingerprint" TEXT NOT NULL,
    "userId" TEXT,
    "companyId" TEXT,
    "url" TEXT,
    "method" TEXT,
    "statusCode" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "ErrorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringInvoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "intervalCount" INTEGER NOT NULL DEFAULT 1,
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "language" TEXT NOT NULL DEFAULT 'de-DE',
    "notes" TEXT,
    "invoiceStatus" TEXT NOT NULL DEFAULT 'draft',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringInvoiceItem" (
    "id" TEXT NOT NULL,
    "recurringInvoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "productNumber" TEXT,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unit" TEXT DEFAULT 'Stück',
    "unitPrice" DECIMAL(12,4) NOT NULL,
    "vatRate" DECIMAL(5,4) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecurringInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringRun" (
    "id" TEXT NOT NULL,
    "recurringInvoiceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "invoiceId" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashBookEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,4) NOT NULL,
    "vatRate" DECIMAL(5,4),
    "counterparty" TEXT,
    "belegNumber" TEXT,
    "expenseId" TEXT,
    "invoiceId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "reversesId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashBookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashBookDailyClose" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "anfangsbestand" DECIMAL(12,4) NOT NULL,
    "einnahmenSum" DECIMAL(12,4) NOT NULL,
    "ausgabenSum" DECIMAL(12,4) NOT NULL,
    "umbuchungenSum" DECIMAL(12,4) NOT NULL,
    "endbestand" DECIMAL(12,4) NOT NULL,
    "physicalCount" DECIMAL(12,4) NOT NULL,
    "differenz" DECIMAL(12,4) NOT NULL,
    "differenzNote" TEXT,
    "entriesSnapshot" JSONB NOT NULL,
    "amendedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashBookDailyClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "accountIban" TEXT,
    "bankName" TEXT,
    "periodFrom" TIMESTAMP(3),
    "periodTo" TIMESTAMP(3),
    "openingBalance" DECIMAL(12,4),
    "closingBalance" DECIMAL(12,4),
    "rawContent" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "valueDate" TIMESTAMP(3) NOT NULL,
    "entryDate" TIMESTAMP(3),
    "amount" DECIMAL(12,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "counterpartyName" TEXT,
    "counterpartyIban" TEXT,
    "purpose" TEXT,
    "endToEndId" TEXT,
    "notes" TEXT,
    "voucherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankReconciliation" (
    "id" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "appliedAmount" DECIMAL(12,4) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "confidence" INTEGER NOT NULL,
    "matchReason" TEXT,
    "voucherId" TEXT,
    "reversalVoucherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "linesJson" TEXT NOT NULL,
    "descriptionPattern" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoucherTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinTSConnection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "blz" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "mockMode" INTEGER NOT NULL DEFAULT 0,
    "pinHash" TEXT,
    "tanMethod" TEXT,
    "systemId" TEXT,
    "lastDialogId" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinTSConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinTSSyncRun" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "txCount" INTEGER NOT NULL DEFAULT 0,
    "tanChallenge" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FinTSSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinTsTransfer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "debtorName" TEXT NOT NULL,
    "debtorIban" TEXT NOT NULL,
    "debtorBic" TEXT,
    "creditorName" TEXT NOT NULL,
    "creditorIban" TEXT NOT NULL,
    "creditorBic" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "purpose" TEXT,
    "endToEndId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tanChallenge" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FinTsTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateType" TEXT NOT NULL DEFAULT 'custom',
    "configJson" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Company_name_idx" ON "Company"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "UserInvitation_companyId_email_idx" ON "UserInvitation"("companyId", "email");

-- CreateIndex
CREATE INDEX "UserInvitation_expiresAt_idx" ON "UserInvitation"("expiresAt");

-- CreateIndex
CREATE INDEX "Customer_companyId_name_idx" ON "Customer"("companyId", "name");

-- CreateIndex
CREATE INDEX "Customer_companyId_vatId_idx" ON "Customer"("companyId", "vatId");

-- CreateIndex
CREATE INDEX "Customer_companyId_customerNumber_idx" ON "Customer"("companyId", "customerNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_companyId_customerNumber_key" ON "Customer"("companyId", "customerNumber");

-- CreateIndex
CREATE INDEX "Supplier_companyId_name_idx" ON "Supplier"("companyId", "name");

-- CreateIndex
CREATE INDEX "Expense_companyId_invoiceDate_idx" ON "Expense"("companyId", "invoiceDate");

-- CreateIndex
CREATE INDEX "Expense_companyId_vatRate_idx" ON "Expense"("companyId", "vatRate");

-- CreateIndex
CREATE INDEX "Expense_supplierId_idx" ON "Expense"("supplierId");

-- CreateIndex
CREATE INDEX "UStvaFiling_companyId_year_idx" ON "UStvaFiling"("companyId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "UStvaFiling_companyId_year_quarter_month_key" ON "UStvaFiling"("companyId", "year", "quarter", "month");

-- CreateIndex
CREATE INDEX "Category_companyId_idx" ON "Category"("companyId");

-- CreateIndex
CREATE INDEX "Product_companyId_sku_idx" ON "Product"("companyId", "sku");

-- CreateIndex
CREATE INDEX "Product_companyId_name_idx" ON "Product"("companyId", "name");

-- CreateIndex
CREATE INDEX "ProductStockHistory_productId_createdAt_idx" ON "ProductStockHistory"("productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_voucherRefId_key" ON "Invoice"("voucherRefId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_issueDate_idx" ON "Invoice"("companyId", "issueDate");

-- CreateIndex
CREATE INDEX "Invoice_companyId_customerId_idx" ON "Invoice"("companyId", "customerId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_status_idx" ON "Invoice"("companyId", "status");

-- CreateIndex
CREATE INDEX "Invoice_companyId_type_idx" ON "Invoice"("companyId", "type");

-- CreateIndex
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_companyId_invoiceNumber_key" ON "Invoice"("companyId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_paymentDate_idx" ON "Payment"("paymentDate");

-- CreateIndex
CREATE INDEX "Account_companyId_type_idx" ON "Account"("companyId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Account_companyId_accountNumber_key" ON "Account"("companyId", "accountNumber");

-- CreateIndex
CREATE INDEX "Voucher_companyId_date_idx" ON "Voucher"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_companyId_voucherNumber_key" ON "Voucher"("companyId", "voucherNumber");

-- CreateIndex
CREATE INDEX "VoucherLine_voucherId_idx" ON "VoucherLine"("voucherId");

-- CreateIndex
CREATE INDEX "VoucherLine_accountId_idx" ON "VoucherLine"("accountId");

-- CreateIndex
CREATE INDEX "VatRate_countryCode_effectiveFrom_idx" ON "VatRate"("countryCode", "effectiveFrom");

-- CreateIndex
CREATE INDEX "VatRateHistory_vatRateId_idx" ON "VatRateHistory"("vatRateId");

-- CreateIndex
CREATE INDEX "VatValidationLog_companyId_entityType_entityId_idx" ON "VatValidationLog"("companyId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "VatValidationLog_vatId_idx" ON "VatValidationLog"("vatId");

-- CreateIndex
CREATE INDEX "VatValidationLog_createdAt_idx" ON "VatValidationLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailConfig_companyId_key" ON "MailConfig"("companyId");

-- CreateIndex
CREATE INDEX "EmailSend_companyId_invoiceId_idx" ON "EmailSend"("companyId", "invoiceId");

-- CreateIndex
CREATE INDEX "EmailSend_createdAt_idx" ON "EmailSend"("createdAt");

-- CreateIndex
CREATE INDEX "Attachment_companyId_entityType_entityId_idx" ON "Attachment"("companyId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "Attachment_contentHash_idx" ON "Attachment"("contentHash");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ErrorEvent_fingerprint_idx" ON "ErrorEvent"("fingerprint");

-- CreateIndex
CREATE INDEX "ErrorEvent_source_lastSeenAt_idx" ON "ErrorEvent"("source", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ErrorEvent_companyId_lastSeenAt_idx" ON "ErrorEvent"("companyId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ErrorEvent_status_lastSeenAt_idx" ON "ErrorEvent"("status", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ReminderTemplate_companyId_idx" ON "ReminderTemplate"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderTemplate_companyId_level_key" ON "ReminderTemplate"("companyId", "level");

-- CreateIndex
CREATE INDEX "RecurringInvoice_companyId_isActive_nextRunAt_idx" ON "RecurringInvoice"("companyId", "isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "RecurringInvoice_customerId_idx" ON "RecurringInvoice"("customerId");

-- CreateIndex
CREATE INDEX "RecurringInvoiceItem_recurringInvoiceId_idx" ON "RecurringInvoiceItem"("recurringInvoiceId");

-- CreateIndex
CREATE INDEX "RecurringRun_recurringInvoiceId_periodStart_idx" ON "RecurringRun"("recurringInvoiceId", "periodStart");

-- CreateIndex
CREATE INDEX "RecurringRun_companyId_status_idx" ON "RecurringRun"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringRun_recurringInvoiceId_periodStart_key" ON "RecurringRun"("recurringInvoiceId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "CashBookEntry_reversesId_key" ON "CashBookEntry"("reversesId");

-- CreateIndex
CREATE INDEX "CashBookEntry_companyId_businessDate_idx" ON "CashBookEntry"("companyId", "businessDate");

-- CreateIndex
CREATE INDEX "CashBookEntry_companyId_type_idx" ON "CashBookEntry"("companyId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "CashBookDailyClose_businessDate_key" ON "CashBookDailyClose"("businessDate");

-- CreateIndex
CREATE INDEX "CashBookDailyClose_companyId_businessDate_idx" ON "CashBookDailyClose"("companyId", "businessDate");

-- CreateIndex
CREATE INDEX "BankStatement_companyId_createdAt_idx" ON "BankStatement"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "BankStatement_companyId_format_idx" ON "BankStatement"("companyId", "format");

-- CreateIndex
CREATE INDEX "BankTransaction_statementId_idx" ON "BankTransaction"("statementId");

-- CreateIndex
CREATE INDEX "BankTransaction_companyId_valueDate_idx" ON "BankTransaction"("companyId", "valueDate");

-- CreateIndex
CREATE INDEX "BankTransaction_companyId_amount_idx" ON "BankTransaction"("companyId", "amount");

-- CreateIndex
CREATE INDEX "BankReconciliation_invoiceId_status_idx" ON "BankReconciliation"("invoiceId", "status");

-- CreateIndex
CREATE INDEX "BankReconciliation_companyId_status_idx" ON "BankReconciliation"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BankReconciliation_bankTransactionId_invoiceId_key" ON "BankReconciliation"("bankTransactionId", "invoiceId");

-- CreateIndex
CREATE INDEX "VoucherTemplate_companyId_sortOrder_idx" ON "VoucherTemplate"("companyId", "sortOrder");

-- CreateIndex
CREATE INDEX "FinTSConnection_companyId_status_idx" ON "FinTSConnection"("companyId", "status");

-- CreateIndex
CREATE INDEX "FinTSConnection_companyId_blz_idx" ON "FinTSConnection"("companyId", "blz");

-- CreateIndex
CREATE INDEX "FinTSSyncRun_connectionId_startedAt_idx" ON "FinTSSyncRun"("connectionId", "startedAt");

-- CreateIndex
CREATE INDEX "FinTSSyncRun_companyId_status_idx" ON "FinTSSyncRun"("companyId", "status");

-- CreateIndex
CREATE INDEX "FinTsTransfer_companyId_status_startedAt_idx" ON "FinTsTransfer"("companyId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "FinTsTransfer_connectionId_startedAt_idx" ON "FinTsTransfer"("connectionId", "startedAt");

-- CreateIndex
CREATE INDEX "FinTsTransfer_endToEndId_idx" ON "FinTsTransfer"("endToEndId");

-- CreateIndex
CREATE INDEX "InvoiceTemplate_companyId_isDefault_idx" ON "InvoiceTemplate"("companyId", "isDefault");

-- CreateIndex
CREATE INDEX "InvoiceTemplate_companyId_templateType_idx" ON "InvoiceTemplate"("companyId", "templateType");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UStvaFiling" ADD CONSTRAINT "UStvaFiling_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockHistory" ADD CONSTRAINT "ProductStockHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_voucherRefId_fkey" FOREIGN KEY ("voucherRefId") REFERENCES "Voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_referenceInvoiceId_fkey" FOREIGN KEY ("referenceInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_recurringInvoiceId_fkey" FOREIGN KEY ("recurringInvoiceId") REFERENCES "RecurringInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_reversedById_fkey" FOREIGN KEY ("reversedById") REFERENCES "Voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherLine" ADD CONSTRAINT "VoucherLine_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherLine" ADD CONSTRAINT "VoucherLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VatRate" ADD CONSTRAINT "VatRate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VatRate" ADD CONSTRAINT "VatRate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VatRateHistory" ADD CONSTRAINT "VatRateHistory_vatRateId_fkey" FOREIGN KEY ("vatRateId") REFERENCES "VatRate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VatRateHistory" ADD CONSTRAINT "VatRateHistory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VatRateHistory" ADD CONSTRAINT "VatRateHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VatValidationLog" ADD CONSTRAINT "VatValidationLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailConfig" ADD CONSTRAINT "MailConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSend" ADD CONSTRAINT "EmailSend_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorEvent" ADD CONSTRAINT "ErrorEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorEvent" ADD CONSTRAINT "ErrorEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderTemplate" ADD CONSTRAINT "ReminderTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringInvoice" ADD CONSTRAINT "RecurringInvoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringInvoice" ADD CONSTRAINT "RecurringInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringInvoice" ADD CONSTRAINT "RecurringInvoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringInvoiceItem" ADD CONSTRAINT "RecurringInvoiceItem_recurringInvoiceId_fkey" FOREIGN KEY ("recurringInvoiceId") REFERENCES "RecurringInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringRun" ADD CONSTRAINT "RecurringRun_recurringInvoiceId_fkey" FOREIGN KEY ("recurringInvoiceId") REFERENCES "RecurringInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringRun" ADD CONSTRAINT "RecurringRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringRun" ADD CONSTRAINT "RecurringRun_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashBookEntry" ADD CONSTRAINT "CashBookEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashBookEntry" ADD CONSTRAINT "CashBookEntry_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashBookEntry" ADD CONSTRAINT "CashBookEntry_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashBookEntry" ADD CONSTRAINT "CashBookEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "CashBookEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashBookEntry" ADD CONSTRAINT "CashBookEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashBookDailyClose" ADD CONSTRAINT "CashBookDailyClose_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashBookDailyClose" ADD CONSTRAINT "CashBookDailyClose_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReconciliation" ADD CONSTRAINT "BankReconciliation_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReconciliation" ADD CONSTRAINT "BankReconciliation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReconciliation" ADD CONSTRAINT "BankReconciliation_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReconciliation" ADD CONSTRAINT "BankReconciliation_reversalVoucherId_fkey" FOREIGN KEY ("reversalVoucherId") REFERENCES "Voucher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherTemplate" ADD CONSTRAINT "VoucherTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinTSConnection" ADD CONSTRAINT "FinTSConnection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinTSSyncRun" ADD CONSTRAINT "FinTSSyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "FinTSConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinTsTransfer" ADD CONSTRAINT "FinTsTransfer_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "FinTSConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceTemplate" ADD CONSTRAINT "InvoiceTemplate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

