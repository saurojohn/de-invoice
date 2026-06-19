import { Module } from '@nestjs/common'
import { ReminderController } from './reminder.controller'
import { ReminderService } from './reminder.service'
import { AutoReminderService } from './auto-reminder.scheduler'
import { PrismaModule } from '../../prisma/prisma.module'
import { MailModule } from '../mail/mail.module'
import { SystemModule } from '../system/system.module'

@Module({
  controllers: [ReminderController],
  providers: [ReminderService, AutoReminderService],
  imports: [PrismaModule, MailModule, SystemModule],
  exports: [ReminderService, AutoReminderService],
})
export class ReminderModule {}
