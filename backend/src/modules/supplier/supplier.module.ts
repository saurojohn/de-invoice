import { Module } from '@nestjs/common';
import { SupplierService } from './supplier.service';
import { SupplierController } from './supplier.controller';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  controllers: [SupplierController],
  providers: [SupplierService],
  imports: [WebhookModule],
  exports: [SupplierService],
})
export class SupplierModule {}
