import { Module } from '@nestjs/common';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { InvoiceTemplateModule } from '../invoice-template/invoice-template.module';

@Module({
  controllers: [InvoiceController],
  providers: [InvoiceService, PaymentService],
  imports: [PrismaModule, StorageModule, InvoiceTemplateModule],
  exports: [InvoiceService, PaymentService],
})
export class InvoiceModule {}
