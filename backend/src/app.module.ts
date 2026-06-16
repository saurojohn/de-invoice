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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRoot([
      {
        // Default: 100 requests / 60s per IP. Auth routes get tighter
        // limits via local @Throttle() decorators on the auth controller
        // — DO NOT add a second named bucket here, because the throttler
        // evaluates ALL configured buckets on every request, which would
        // also cap logged-in users at 5 req/min (effectively unusable).
        name: 'default',
        ttl: 60_000,
        limit: 100,
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
    ScheduleModule.forRoot(),
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
