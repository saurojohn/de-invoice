import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { CustomerStatementService } from './customer-statement.service';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  controllers: [CustomerController],
  providers: [CustomerService, CustomerStatementService],
  imports: [WebhookModule],
  exports: [CustomerService, CustomerStatementService],
})
export class CustomerModule {}
