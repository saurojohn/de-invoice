import { Module } from '@nestjs/common';
import { BankImportController } from './bank-import.controller';
import { BankImportService } from './bank-import.service';
import { InvoiceModule } from '../invoice/invoice.module';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  // InvoiceModule is imported (not just PaymentService)
  // because we need to call PaymentService.create() to
  // auto-flip the invoice to "paid" when a candidate is
  // confirmed. PaymentService is exported from InvoiceModule.
  //
  // AccountingModule is imported because the confirm
  // flow also books a GoBD Voucher (Bank 1200 →
  // Forderung 1406) so the double-entry ledger stays
  // in sync with the bank reality. VoucherService is
  // exported from AccountingModule.
  imports: [InvoiceModule, AccountingModule],
  controllers: [BankImportController],
  providers: [BankImportService],
  exports: [BankImportService],
})
export class BankImportModule {}
