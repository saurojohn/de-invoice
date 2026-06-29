import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { CustomerStatementService } from './customer-statement.service';
import { CustomerStatementBatchService } from './customer-statement-batch.service';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  controllers: [CustomerController],
  providers: [
    CustomerService,
    CustomerStatementService,
    CustomerStatementBatchService,
  ],
  imports: [WebhookModule],
  exports: [
    CustomerService,
    CustomerStatementService,
    CustomerStatementBatchService,
  ],
})
export class CustomerModule {}
