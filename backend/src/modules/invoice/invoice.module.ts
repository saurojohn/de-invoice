import { Module } from '@nestjs/common';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { InvoiceTemplateModule } from '../invoice-template/invoice-template.module';
import { WebhookModule } from '../webhook/webhook.module';
import { ReminderModule } from '../reminder/reminder.module';
// Tier 58: PaymentService.create() and InvoiceService.createCreditNote()
// need CreditBalanceService to route overpayments / Gutschrift
// overages into the customer credit ledger.
import { CustomerModule } from '../customer/customer.module';
// Tier 118: multi-currency. InvoiceService.create() needs
// ExchangeRateService to compute the EUR equivalent at issue
// time (subtotal/totalVat/total stay in the original currency;
// eurSubtotal/eurTotalVat/eurTotal are pre-computed for
// cross-currency aggregation in EÜR/UStVA/BWA/GuV).
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  controllers: [InvoiceController],
  providers: [InvoiceService, PaymentService],
  imports: [
    PrismaModule,
    StorageModule,
    InvoiceTemplateModule,
    WebhookModule,
    // Tier 37: PaymentService needs ReminderService so it can
    // auto-cancel open Mahnungen when the invoice flips to
    // 'paid'. Forward-only dep — ReminderModule doesn't import
    // back into Invoice.
    ReminderModule,
    // Tier 58: see comment above.
    CustomerModule,
    // Tier 118: see comment above.
    ExchangeRateModule,
  ],
  exports: [InvoiceService, PaymentService],
})
export class InvoiceModule {}
