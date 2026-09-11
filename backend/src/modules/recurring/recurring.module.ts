import { Module } from '@nestjs/common';
import { RecurringController } from './recurring.controller';
import { RecurringService } from './recurring.service';
import { RecurringScheduler } from './recurring.scheduler';
// Tier 119: RecurringScheduler records each tick to
// the shared CronHealthService so the admin
// dashboard can see "recurring-invoices-daily last
// ran N hours ago" alongside the other 6 crons.
import { AdminModule } from '../admin/admin.module';
// Tier 129: after a successful template run, the
// service emails the generated invoice to the
// customer (when sendEmail=true on the template).
// We import InvoiceModule (not just the email
// service) to keep the DI graph consistent —
// InvoiceEmailService's own dependencies (Prisma,
// MailService, StorageService, InvoiceTemplateService)
// are already wired in InvoiceModule.
import { InvoiceModule } from '../invoice/invoice.module';
// Tier 362: generated invoices get their EUR equivalents from the same
// ExchangeRateService snapshot as InvoiceService.create.
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  imports: [AdminModule, InvoiceModule, ExchangeRateModule],
  controllers: [RecurringController],
  providers: [RecurringService, RecurringScheduler],
  exports: [RecurringService],
})
export class RecurringModule {}
