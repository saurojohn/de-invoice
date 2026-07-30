import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RecurringService } from './recurring.service';
// Tier 119: wrap every scheduler body with the
// shared CronHealthService so the admin dashboard
// can show "last run" / "next run" / "last error".
// The wrap is a no-op on the happy path; on
// failure it records the error message before
// re-throwing so the cron keeps its retry
// semantics.
import { CronHealthService } from '../admin/cron-health.service';

/**
 * Daily cron tick for recurring invoice generation.
 *
 * Schedule: every day at 06:00 Europe/Berlin. At that
 * moment we scan all active recurring templates whose
 * `nextRunAt ≤ now` and call `runOne()` on each. The
 * service handles all the locking + idempotency, so this
 * scheduler is a thin loop.
 *
 * Timezone: Europe/Berlin (DST-aware via @nestjs/schedule).
 * Without an explicit timezone, the server's TZ would
 * apply — fine on a Berlin server, wrong on UTC.
 *
 * Env override:
 *   DISABLE_CRON=1  → skip the tick (used in dev when
 *                      you only want manual triggers)
 */
@Injectable()
export class RecurringScheduler {
  private readonly logger = new Logger(RecurringScheduler.name);

  constructor(
    private readonly svc: RecurringService,
    private readonly health: CronHealthService,
  ) {}

  /**
   * Run at 06:00 every day in Europe/Berlin. The trailing
   * string is parsed by @nestjs/schedule's CronExpression
   * helper (cron-parser under the hood).
   *
   * `name` is a stable identifier so the scheduler
   * registry can be inspected at /__schedules__ in dev.
   */
  @Cron('0 6 * * *', {
    name: 'recurring-invoices-daily',
    timeZone: 'Europe/Berlin',
  })
  async dailyTick() {
    if (process.env.DISABLE_CRON === '1') {
      this.logger.debug('Cron disabled via DISABLE_CRON=1 — skipping tick')
      return
    }
    this.logger.log('Recurring-invoice daily tick starting')
    return this.health.wrap('recurring-invoices-daily', async () => {
      const results = await this.svc.runDueTemplates()
      const succeeded = results.filter((r) => r.result === 'success').length
      const failed = results.filter((r) => r.result === 'failed').length
      const skipped = results.filter((r) => r.result === 'skipped').length
      this.logger.log(
        `Recurring-invoice tick done — ` +
        `success: ${succeeded}, failed: ${failed}, skipped: ${skipped}`,
      )
      return `success: ${succeeded}, failed: ${failed}, skipped: ${skipped}`
    })
  }
}
