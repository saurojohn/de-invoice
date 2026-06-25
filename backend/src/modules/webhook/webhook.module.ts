import { Module } from '@nestjs/common'
import { WebhookController } from './webhook.controller'
import { WebhookService } from './webhook.service'
import { WebhookRetryWorker } from './webhook-retry.scheduler'
import { PrismaModule } from '../../prisma/prisma.module'

@Module({
  controllers: [WebhookController],
  providers: [WebhookService, WebhookRetryWorker],
  imports: [PrismaModule],
  // Export the service so other modules
  // (Invoice, Payment, Voucher) can call
  // webhooks.emit() to fire events.
  exports: [WebhookService],
})
export class WebhookModule {}
