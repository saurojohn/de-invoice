import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { InvoiceModule } from '../invoice/invoice.module'
import { TimeEntryController } from './time-entry.controller'
import { TimeEntryService } from './time-entry.service'

@Module({
  imports: [PrismaModule, InvoiceModule],
  controllers: [TimeEntryController],
  providers: [TimeEntryService],
})
export class TimeTrackingModule {}
