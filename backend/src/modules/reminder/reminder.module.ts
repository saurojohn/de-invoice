import { Module } from '@nestjs/common';
import { ReminderController } from './reminder.controller';
import { ReminderService } from './reminder.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  controllers: [ReminderController],
  providers: [ReminderService],
  imports: [PrismaModule],
  exports: [ReminderService],
})
export class ReminderModule {}