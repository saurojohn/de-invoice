import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { CronHealthService } from '../admin/cron-health.service'
import { FilingDeadlineMailService } from './filing-deadline-mail.service'

/** Tier 803 — every morning at 07:00 (Berlin): the deadline reminders. */
@Injectable()
export class FilingDeadlineMailScheduler {
  private readonly logger = new Logger(FilingDeadlineMailScheduler.name)

  constructor(
    private reminders: FilingDeadlineMailService,
    private health: CronHealthService,
  ) {}

  @Cron('0 7 * * *', { name: 'filing-deadline-reminders', timeZone: 'Europe/Berlin' })
  async run() {
    if (process.env.DISABLE_CRON === '1') {
      this.logger.debug('Skipping (DISABLE_CRON=1)')
      return
    }
    return this.health.wrap('filing-deadline-reminders', async () => {
      const r = await this.reminders.remindAll()
      this.logger.log(`filing deadline reminders: companies=${r.companies} sent=${r.sent} errors=${r.errors}`)
      return `companies=${r.companies} sent=${r.sent} errors=${r.errors}`
    })
  }
}
