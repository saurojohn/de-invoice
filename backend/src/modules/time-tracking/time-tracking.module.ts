import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { InvoiceModule } from '../invoice/invoice.module'
import { TimeEntryController } from './time-entry.controller'
import { TimeEntryService } from './time-entry.service'
import { TimeProjectController } from './time-project.controller'
import { TimeProjectService } from './time-project.service'

@Module({
  imports: [PrismaModule, InvoiceModule],
  controllers: [TimeEntryController, TimeProjectController],
  providers: [TimeEntryService, TimeProjectService],
})
export class TimeTrackingModule {}
