/**
 * Auto-backup scheduler — Tier 120.
 *
 * Runs scripts/backup.sh every day at 04:00 Europe/Berlin.
 * Why 04:00? It's after the 03:00 cron-health-cleanup and
 * the 02:00 ECB-rate-refresh, so we're not contending with
 * other DB-heavy jobs. It's also off-peak for the user
 * (Berater's day usually starts at 08:00, Mandant earlier
 * but on the same DB).
 *
 * Why wrap with CronHealthService? So the auto-backup
 * appears on the system-health page next to the other
 * 7 crons. If the backup script fails, the operator
 * sees a red dot at 04:00 and can click through to the
 * full log via the backup dashboard.
 *
 * Failure handling: a failed backup is NOT fatal. We
 * log the error and re-throw so CronHealthService records
 * it; the manual-trigger endpoint stays usable. The
 * operator's first action on a red dot is usually
 * "trigger a manual backup" — the script will create
 * a new stage dir even if the cron one is missing.
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { CronHealthService } from '../admin/cron-health.service'
import { BackupService } from './backup.service'

@Injectable()
export class BackupScheduler {
  private readonly logger = new Logger(BackupScheduler.name)

  constructor(
    private readonly backup: BackupService,
    private readonly health: CronHealthService,
  ) {}

  @Cron('0 4 * * *', {
    name: 'daily-auto-backup',
    timeZone: 'Europe/Berlin',
  })
  async dailyTick() {
    if (process.env.DISABLE_CRON === '1') {
      this.logger.debug('Cron disabled via DISABLE_CRON=1 — skipping tick')
      return
    }
    this.logger.log('Auto-backup daily tick starting')
    return this.health.wrap('daily-auto-backup', async () => {
      const result = await this.backup.runBackup()
      if (!result.success) {
        this.logger.error(`Auto-backup failed: ${result.id}`)
        // Throw so the wrap records 'failed' and the
        // health dot turns red. We log the full log
        // here so it's in the NestJS logger even though
        // the wrap's summary is truncated to 200 chars.
        this.logger.error(`Auto-backup log tail:\n${result.log}`)
        throw new Error(`backup script exited non-zero: ${result.id}`)
      }
      this.logger.log(
        `Auto-backup OK: id=${result.id} size=${result.sizeBytes}B ` +
          `duration=${result.durationMs}ms`,
      )
      return `id=${result.id} size=${result.sizeBytes}B`
    })
  }
}
