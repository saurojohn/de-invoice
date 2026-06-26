import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  controllers: [CustomerController],
  providers: [CustomerService],
  imports: [WebhookModule],
  exports: [CustomerService],
})
export class CustomerModule {}
