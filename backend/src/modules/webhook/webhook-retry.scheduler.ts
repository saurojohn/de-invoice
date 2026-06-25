// Webhook delivery retry worker.
//
// Cron: every 1 minute. Looks up all
// `WebhookDelivery` rows where
//   status='failed' AND nextRetryAt <= now()
// and re-issues the HTTP POST via
// `webhookService.retryDelivery(id)`.
//
// The retry policy is "3 attempts with
// exponential backoff (1min, 5min, 30min)":
//
//   attempt 1 (initial): emit() in
//   invoice.service.ts
//     → on 5xx / network error: status='failed',
//       nextRetryAt=now+1min
//   attempt 2: this cron, 1min later
//     → on 5xx / network error: status='failed',
//       nextRetryAt=now+5min
//   attempt 3: this cron, 5min later
//     → on 5xx / network error: status='failed',
//       nextRetryAt=now+30min
//   attempt 4: this cron, 30min later
//     → on 5xx / network error: retryCount=3,
//       status='exhausted', nextRetryAt=null
//
// Why a separate cron, not a `setTimeout`
// per failed delivery?
//   - `setTimeout` doesn't survive a backend
//     restart — the in-memory queue is lost.
//   - setTimeout fires one task at a time
//     even when 100 deliveries fail at once
//     (a burst of 5xx errors from a broken
//     receiver).
//   - DB rows ARE durable. The cron just
//     reads the queue.
//
// Why every 1 minute?
//   - Cheapest cron granularity that's
//     still "responsive" enough for
//     webhook delivery.
//   - If you need faster retries
//     (sub-minute), switch to a queue
//     worker (Bull/BullMQ).
//
// Why `protected` method?
//   The cron worker is internal — we
//   don't expose /api/v1/admin/retry-now.
//   If we did, the operator could trigger
//   it from the dashboard for debugging
//   ("my receiver is back up, retry the
//   failed ones now"). That's a Tier 14.5
//   feature, not for this PR.

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { WebhookService } from './webhook.service'

@Injectable()
export class WebhookRetryWorker {
  private readonly logger = new Logger(WebhookRetryWorker.name)

  constructor(private readonly webhooks: WebhookService) {}

  // Every minute. If the backend is
  // down for 2 hours, the next startup
  // resumes from the DB state — no lost
  // retries.
  @Cron(CronExpression.EVERY_MINUTE, { name: 'webhook-retry-worker' })
  async run(): Promise<void> {
    const due = await this.webhooks.findDueRetries(50)
    if (due.length === 0) return

    this.logger.log(`webhook retry worker: ${due.length} due deliveries`)

    let succeeded = 0
    let failed = 0
    let exhausted = 0
    for (const d of due) {
      try {
        const result = await this.webhooks.retryDelivery(d.id)
        if (result === 'success') succeeded++
        else if (result === 'exhausted') exhausted++
        else failed++
      } catch (err) {
        failed++
        this.logger.warn(
          `webhook retry ${d.id} threw: ${(err as Error).message}`,
        )
      }
    }
    this.logger.log(
      `webhook retry worker: done — ${succeeded} succeeded, ${failed} failed, ${exhausted} exhausted`,
    )
  }
}
