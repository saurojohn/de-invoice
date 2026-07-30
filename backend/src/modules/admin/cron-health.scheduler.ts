/**
 * cron-health.scheduler — Tier 119 nightly cleanup.
 *
 * Runs at 03:00 Europe/Berlin (off-peak so a long
 * DELETE doesn't compete with the 02:00 ECB rate
 * refresh or the 02:00 USt-ID reverify). The cleanup
 * drops CronHealth rows older than 7 days so the
 * table stays small (~50 rows × 7 days = 350 rows
 * max).
 *
 * Why nightly, not hourly? CronHealth rows are
 * cheap to keep (a few hundred rows of small JSON)
 * and the cleanup is a single DELETE with an index
 * range scan. Hourly cleanup would be over-engineering.
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { CronHealthService } from './cron-health.service'

@Injectable()
export class CronHealthScheduler {
  private readonly logger = new Logger(CronHealthScheduler.name)

  constructor(private readonly health: CronHealthService) {}

  @Cron('0 3 * * *', {
    name: 'cron-health-cleanup',
    timeZone: 'Europe/Berlin',
  })
  async dailyCleanup() {
    if (process.env.DISABLE_CRON === '1') {
      this.logger.debug('Cron disabled via DISABLE_CRON=1 — skipping tick')
      return
    }
    return this.health.wrap('cron-health-cleanup', async () => {
      const deleted = await this.health.cleanOld(7)
      this.logger.log(`CronHealth cleanup: deleted ${deleted} rows older than 7 days`)
      return { deleted }
    })
  }
}
