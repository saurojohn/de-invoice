import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { CustomerStatementService } from './customer-statement.service';
import { CustomerStatementBatchService } from './customer-statement-batch.service';
import { CreditBalanceService } from './credit-balance.service';
import { WebhookModule } from '../webhook/webhook.module';
// Tier 58: CreditBalanceService.payout() posts a SKR03-conform
// Voucher (1800 Bank ↔ 1210 Forderungen). Needs VoucherService.
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  controllers: [CustomerController],
  providers: [
    CustomerService,
    CustomerStatementService,
    CustomerStatementBatchService,
    CreditBalanceService,
  ],
  imports: [WebhookModule, AccountingModule],
  exports: [
    CustomerService,
    CustomerStatementService,
    CustomerStatementBatchService,
    CreditBalanceService,
  ],
})
export class CustomerModule {}
