import { Module } from '@nestjs/common';
import { ExpenseService } from './expense.service';
import { ExpenseController } from './expense.controller';
import { SupplierModule } from '../supplier/supplier.module';
import { EInvoiceController } from './e-invoice/e-invoice.controller';
import { EInvoiceImportService } from './e-invoice/e-invoice-import.service';

@Module({
  imports: [SupplierModule],
  // Tier 573: EInvoiceController first — its `e-invoice/…` paths must not be
  // read as an expense id by ExpenseController's `:id` routes.
  controllers: [EInvoiceController, ExpenseController],
  providers: [ExpenseService, EInvoiceImportService],
  exports: [ExpenseService],
})
export class ExpenseModule {}
