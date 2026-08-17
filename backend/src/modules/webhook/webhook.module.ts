import { Module } from '@nestjs/common'
import { WebhookController } from './webhook.controller'
import { WebhookService } from './webhook.service'
import { WebhookRetryWorker } from './webhook-retry.scheduler'
import { PrismaModule } from '../../prisma/prisma.module'
// Tier 119: the retry worker records every tick
// to the shared CronHealthService so the admin
// dashboard can see "webhook-retry-worker last
// ran N seconds ago, last error: …".
import { AdminModule } from '../admin/admin.module'
// Tier 202: WebhookController writes
// `webhook.requeue` activity events to
// the AuditLog via AuditService.
import { AuditModule } from '../audit/audit.module'

@Module({
  controllers: [WebhookController],
  providers: [WebhookService, WebhookRetryWorker],
  imports: [PrismaModule, AdminModule, AuditModule],
  // Export the service so other modules
  // (Invoice, Payment, Voucher) can call
  // webhooks.emit() to fire events.
  exports: [WebhookService],
})
export class WebhookModule {}
