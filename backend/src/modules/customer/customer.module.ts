import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { CustomerStatementService } from './customer-statement.service';
import { CustomerStatementBatchService } from './customer-statement-batch.service';
import { CustomerStatementEmailService } from './customer-statement-email.service';
import { CreditBalanceService } from './credit-balance.service';
import { WebhookModule } from '../webhook/webhook.module';
// Tier 58: CreditBalanceService.payout() posts a SKR03-conform
// Voucher (1800 Bank ↔ 1210 Forderungen). Needs VoucherService.
import { AccountingModule } from '../accounting/accounting.module';
// Tier 154: statement email needs MailService for SMTP
// delivery. MailModule exports the service.
import { MailModule } from '../mail/mail.module';

@Module({
  controllers: [CustomerController],
  providers: [
    CustomerService,
    CustomerStatementService,
    CustomerStatementBatchService,
    CustomerStatementEmailService,
    CreditBalanceService,
  ],
  imports: [WebhookModule, AccountingModule, MailModule],
  exports: [
    CustomerService,
    CustomerStatementService,
    CustomerStatementBatchService,
    CustomerStatementEmailService,
    CreditBalanceService,
  ],
})
export class CustomerModule {}
