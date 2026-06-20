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
import { StorageModule } from './modules/storage/storage.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ReminderModule } from './modules/reminder/reminder.module';
import { MailModule } from './modules/mail/mail.module';
import { UsersModule } from './modules/users/users.module';
import { RecurringModule } from './modules/recurring/recurring.module';
import { CashBookModule } from './modules/cashbook/cashbook.module';
import { BankImportModule } from './modules/bank-import/bank-import.module';
import { SupplierModule } from './modules/supplier/supplier.module';
import { ExpenseModule } from './modules/expense/expense.module';
import { AttachmentsModule } from './modules/attachment/attachments.module';
import { VatValidationModule } from './modules/vat-validation/vat-validation.module';
import { SystemModule } from './modules/system/system.module';
import { TwoFactorModule } from './modules/auth/two-factor/two-factor.module';

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
    StorageModule,
    InventoryModule,
    ReminderModule,
    UsersModule,
    RecurringModule,
    CashBookModule,
    BankImportModule,
    SupplierModule,
    ExpenseModule,
    AttachmentsModule,
    VatValidationModule,
    SystemModule,
    TwoFactorModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
