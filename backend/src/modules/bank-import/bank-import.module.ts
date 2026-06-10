import { Module } from '@nestjs/common';
import { BankImportController } from './bank-import.controller';
import { BankImportService } from './bank-import.service';
import { InvoiceModule } from '../invoice/invoice.module';

@Module({
  // InvoiceModule is imported (not just PaymentService)
  // because we need to call PaymentService.create() to
  // auto-flip the invoice to "paid" when a candidate is
  // confirmed. PaymentService is exported from InvoiceModule.
  imports: [InvoiceModule],
  controllers: [BankImportController],
  providers: [BankImportService],
  exports: [BankImportService],
})
export class BankImportModule {}
