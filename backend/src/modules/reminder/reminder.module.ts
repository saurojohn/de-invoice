import { Module } from '@nestjs/common'
import { ReminderController } from './reminder.controller'
import { ReminderService } from './reminder.service'
import { AutoReminderService } from './auto-reminder.scheduler'
import { BulkReminderService } from './bulk-reminder.service'
import { MahnungspauseService } from './mahnungspause.service'
import { MahnungspauseController } from './mahnungspause.controller'
import { PrismaModule } from '../../prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { SystemModule } from '../system/system.module'
// Tier 119: AutoReminderService injects
// CronHealthService for the @Cron body wrap.
import { AdminModule } from '../admin/admin.module'

@Module({
  controllers: [ReminderController, MahnungspauseController],
  providers: [
    ReminderService,
    AutoReminderService,
    BulkReminderService,
    MahnungspauseService,
  ],
  imports: [PrismaModule, MailModule, SystemModule, AdminModule],
  // Export MahnungspauseService so ReminderService can
  // inject it (the two live in the same module, so
  // DI works without exporting, but exporting makes
  // the dependency visible to future modules that
  // might want to pause Mahnungen from elsewhere).
  exports: [
    ReminderService,
    AutoReminderService,
    BulkReminderService,
    MahnungspauseService,
  ],
})
export class ReminderModule {}
