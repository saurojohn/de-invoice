/**
 * BackupModule — Tier 120 admin backup management.
 *
 * Three pieces:
 *   - BackupService:    list/run/verify/delete backup
 *                       stage dirs on disk. Reads
 *                       $BACKUP_ROOT (default
 *                       ~/data/backups/de-invoice) and
 *                       spawns scripts/backup.sh.
 *   - BackupController: REST surface for the admin
 *                       backups page.
 *   - BackupScheduler:  daily auto-backup at 04:00
 *                       Europe/Berlin. Wrapped with
 *                       CronHealthService so it shows
 *                       up on the system-health page
 *                       alongside the other 7 crons.
 *
 * The module depends on AdminModule's CronHealthService
 * (for the scheduler wrap). CronHealthService is
 * exported from AdminModule, so we just import it.
 */
import { Module } from '@nestjs/common'
import { AdminModule } from '../admin/admin.module'
import { SystemModule } from '../system/system.module'
import { BackupController } from './backup.controller'
import { BackupScheduler } from './backup.scheduler'
import { BackupService } from './backup.service'
import { ProductionBackupsService } from './production-backups.service'
import { RestoreCheckService } from './restore-check.service'

@Module({
  imports: [AdminModule, SystemModule],
  controllers: [BackupController],
  providers: [BackupService, BackupScheduler, ProductionBackupsService, RestoreCheckService],
  exports: [BackupService, ProductionBackupsService],
})
export class BackupModule {}
