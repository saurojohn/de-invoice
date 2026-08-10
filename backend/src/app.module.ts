import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { CompanyModule } from './modules/company/company.module';
import { CustomerModule } from './modules/customer/customer.module';
import { InvoiceModule } from './modules/invoice/invoice.module';
import { ProductModule } from './modules/product/product.module';
import { VatRateModule } from './modules/vat-rate/vat-rate.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { ReportsModule } from './modules/reports/reports.module';
// Tier 108: SEPA pain.001 batch payments.
import { PaymentsModule } from './modules/payments/payments.module';
// Tier 28: full-text search with snippet highlight.
// Owns the /search/customers, /search/products,
// /search/invoices endpoints. The service queries
// the Postgres tsvector STORED columns defined in
// migration 20260701000001_search_tsv.
import { SearchModule } from './modules/search/search.module';
// Tier 29: OCR pipeline for Eingangsrechnung scan
// ingestion. Owns /api/v1/ocr/scan (multipart upload)
// and /api/v1/ocr/fixture (test endpoint). v1 returns
// a deterministic mock; v2 will swap in tesseract.js
// or a cloud OCR provider.
import { OcrModule } from './modules/ocr/ocr.module';
import { StorageModule } from './modules/storage/storage.module';
import { ExchangeRateModule } from './modules/exchange-rate/exchange-rate.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ReminderModule } from './modules/reminder/reminder.module';
import { NoteTemplateModule } from './modules/note-template/note-template.module';
import { MailModule } from './modules/mail/mail.module';
import { UsersModule } from './modules/users/users.module';
import { RecurringModule } from './modules/recurring/recurring.module';
import { AdminModule } from './modules/admin/admin.module';
import { BackupModule } from './modules/backup/backup.module';
import { CashBookModule } from './modules/cashbook/cashbook.module';
import { BankImportModule } from './modules/bank-import/bank-import.module';
import { InstallmentPlanModule } from './modules/installment-plan/installment-plan.module';
import { SupplierModule } from './modules/supplier/supplier.module';
import { ExpenseModule } from './modules/expense/expense.module';
import { AttachmentsModule } from './modules/attachment/attachments.module';
import { VatValidationModule } from './modules/vat-validation/vat-validation.module';
import { SystemModule } from './modules/system/system.module';
import { TwoFactorModule } from './modules/auth/two-factor/two-factor.module';
import { FinTsModule } from './modules/fints/fints.module';
import { InvoiceTemplateModule } from './modules/invoice-template/invoice-template.module';
import { PortalModule } from './modules/portal/portal.module';
// Tier 130: customer-portal = the multi-invoice
// login flow (request session by email → see all
// invoices). Distinct from the existing portal
// module which is the single-invoice payment link.
import { CustomerPortalModule } from './modules/customer-portal/customer-portal.module';
import { HealthModule } from './modules/health/health.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { AuditModule } from './modules/audit/audit.module';
import { SigningModule } from './modules/signing/signing.module';
import { GobdExportModule } from './modules/gobd-export/gobd-export.module';
import { BeraterModule } from './modules/berater/berater.module';
// Tier 83: Anlagenverzeichnis + AfA. Owns the
// Asset model (Sachanlagen) and the linear AfA
// computation. The BilanzService + GuVService
// read the Asset pool to fill the 0100-0500
// Anlagevermögen + 7a Abschreibungen positions
// on the § 266 HGB / § 275 HGB reports.
import { AssetsModule } from './modules/assets/assets.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRoot([
      {
        // Default: 600 requests / 60s per IP. Auth routes get tighter
        // limits via local @Throttle() decorators on the auth controller
        // — DO NOT add a second named bucket here, because the throttler
        // evaluates ALL configured buckets on every request, which would
        // also cap logged-in users at 5 req/min (effectively unusable).
        //
        // 600/60s = 10 req/s sustained. Plenty for a single user
        // (≤30 req/min in heavy use). Behind a corporate proxy
        // shared by 50 employees, this is roughly 0.2 req/s per user
        // — comfortable. Was 100/60s (too tight for the 2FA e2e
        // suite which generates 20+ requests in 60s), then 300/60s
        // (still tight for run-all + a real user), now 600/60s.
        // If you need to tune this for a specific deployment,
        // consider per-user limits via a custom throttler storage
        // (Redis) rather than a higher number here.
        name: 'default',
        ttl: 60_000,
        limit: 600,
      },
    ]),
    PrismaModule,
    MailModule,
    AuthModule,
    CompanyModule,
    CustomerModule,
    InvoiceModule,
    ProductModule,
    VatRateModule,
    AccountingModule,
    ReportsModule,
    PaymentsModule,
    SearchModule,
    OcrModule,
    StorageModule,
    InventoryModule,
    ReminderModule,
    NoteTemplateModule,
    ExchangeRateModule,
    UsersModule,
    RecurringModule,
    AdminModule,
    BackupModule,
    CashBookModule,
    BankImportModule,
    InstallmentPlanModule,
    SupplierModule,
    ExpenseModule,
    AttachmentsModule,
    VatValidationModule,
    SystemModule,
    TwoFactorModule,
    FinTsModule,
    InvoiceTemplateModule,
    // Tier 130: see customer-portal/customer-portal.module.ts
    CustomerPortalModule,
    PortalModule,
    HealthModule,
    BeraterModule,
    AssetsModule,
    WebhookModule,
    AuditModule,
    SigningModule,
    // Tier 166: GoBD § 147 AO archive export
    // (manifest + SHA-256 + streaming archiver).
    // Wired here so the route is available on
    // /api/v1/gobd-export without forcing the
    // caller to know about the module path.
    GobdExportModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
