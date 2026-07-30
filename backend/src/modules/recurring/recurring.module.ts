import { Module } from '@nestjs/common';
import { RecurringController } from './recurring.controller';
import { RecurringService } from './recurring.service';
import { RecurringScheduler } from './recurring.scheduler';
// Tier 119: RecurringScheduler records each tick to
// the shared CronHealthService so the admin
// dashboard can see "recurring-invoices-daily last
// ran N hours ago" alongside the other 6 crons.
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [AdminModule],
  controllers: [RecurringController],
  providers: [RecurringService, RecurringScheduler],
  exports: [RecurringService],
})
export class RecurringModule {}
