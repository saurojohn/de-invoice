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
import { ErrorTrackingService } from '../system/error-tracking.service'
import { BackupService } from './backup.service'
import { ProductionBackupsService } from './production-backups.service'
import { RestoreCheckService, describeLost } from './restore-check.service'

@Injectable()
export class BackupScheduler {
  private readonly logger = new Logger(BackupScheduler.name)

  constructor(
    private readonly backup: BackupService,
    private readonly health: CronHealthService,
    private readonly production: ProductionBackupsService,
    private readonly errors: ErrorTrackingService,
    private readonly restoreCheck: RestoreCheckService,
  ) {}

  /**
   * Tier 727: the files of the storage volume, every hour, into the mirror
   * (production-backups.service.ts). Off where BACKUP_FILES_DIR is not set.
   */
  @Cron('20 * * * *', { name: 'hourly-files-backup', timeZone: 'Europe/Berlin' })
  async hourlyFiles() {
    if (process.env.DISABLE_CRON === '1' || !this.production.filesDir) return
    return this.health.wrap('hourly-files-backup', async () => {
      const r = await this.production.mirrorFiles()
      return `${r.files} files, ${r.copied} copied, ${r.versioned} earlier versions kept`
    })
  }

  /**
   * Tier 727: every hour, whether the database dumps and the file mirror are
   * fresh. A backup that stopped turns this scheduler red and is reported as
   * an error event — which goes to the notification channels (Slack / e-mail,
   * Einstellungen → System). Off where neither is configured.
   */
  @Cron('40 * * * *', { name: 'backup-freshness-check', timeZone: 'Europe/Berlin' })
  async freshness() {
    if (process.env.DISABLE_CRON === '1') return
    if (!this.production.dbDir && !this.production.filesDir) return
    return this.health.wrap('backup-freshness-check', async () => this.checkFreshness())
  }

  /** the check itself — also behind POST /admin/backups/status/check */
  async checkFreshness(): Promise<string> {
    const db = this.production.dbStatus()
    const files = this.production.filesStatus()
    const problems: string[] = []
    // a backup that has not happened yet is no alarm while the app has been
    // up for less than the age allowed (a fresh deploy, a restart)
    const upHours = process.uptime() / 3600
    if (db.configured && !db.ok && !(db.latestAt == null && upHours < db.maxAgeHours)) {
      problems.push(db.latestAt
        ? `Letzte Datenbanksicherung vor ${db.ageHours} Std. (${db.latestAt}) — erwartet höchstens ${db.maxAgeHours} Std.`
        : `Keine Datenbanksicherung in ${db.dir} gefunden`)
    }
    if (files.configured && !files.ok && !(files.lastRunAt == null && upHours < files.maxAgeHours)) {
      problems.push(files.lastRunAt
        ? `Letzte Dateisicherung vor ${files.ageHours} Std. (${files.lastRunAt}) — erwartet höchstens ${files.maxAgeHours} Std.`
        : `Noch keine Dateisicherung in ${files.dir}`)
    }
    // Tier 727b: the disk the backups are on — before it is full, not after
    for (const disk of [db.disk, files.disk]) {
      if (disk?.low) {
        problems.push(`Wenig Speicherplatz für die Sicherungen: ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GB frei (${disk.freePercent} %)`)
        break
      }
    }
    // Tier 733: invoices a restore left only as their kept copy
    const restore = await this.restoreCheck.check()
    if (restore.lost.length) problems.push(describeLost(restore.lost))
    if (problems.length) {
      const message = `Datensicherung: ${problems.join('; ')}`
      await this.errors.capture({ source: 'backend', kind: 'manual', message, context: { db, files, lost: restore.lost } }).catch(() => {})
      throw new Error(message)
    }
    return `db ${db.configured ? `${db.ageHours} h` : '—'}, files ${files.configured ? `${files.ageHours} h` : '—'}`
  }

  @Cron('0 4 * * *', {
    name: 'daily-auto-backup',
    timeZone: 'Europe/Berlin',
  })
  async dailyTick() {
    if (process.env.DISABLE_CRON === '1') {
      this.logger.debug('Cron disabled via DISABLE_CRON=1 — skipping tick')
      return
    }
    // Tier 558: in the container there is nothing to run — the nightly tick
    // failed every night at 04:00 there (red scheduler, an error event, a
    // notification) although the backup container had done its job at 03:00.
    if (!this.backup.scriptAvailable()) {
      this.logger.log('Auto-backup skipped: no backup script in this deployment (backups are taken outside the app)')
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
