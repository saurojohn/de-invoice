import { Module } from '@nestjs/common';
import { CashBookController } from './cashbook.controller';
import { KassenbuchService } from './kassenbuch.service';
// Tier 425: a cash receipt for an invoice records a Payment.
import { InvoiceModule } from '../invoice/invoice.module';

@Module({
  imports: [InvoiceModule],
  controllers: [CashBookController],
  providers: [KassenbuchService],
  exports: [KassenbuchService],
})
export class CashBookModule {}
