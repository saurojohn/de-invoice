import { Module } from '@nestjs/common';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { InvoiceTemplateModule } from '../invoice-template/invoice-template.module';
import { WebhookModule } from '../webhook/webhook.module';
import { ReminderModule } from '../reminder/reminder.module';

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
  ],
  exports: [InvoiceService, PaymentService],
})
export class InvoiceModule {}
