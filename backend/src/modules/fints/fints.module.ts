import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { FinTsController } from './fints.controller'
import { FinTsService } from './fints.service'
import { FintsSyncScheduler } from './fints-sync.scheduler'
// Tier 22: bank-import is imported (not the
// other way around) so we don't create a
// circular dep at the module-graph level.
import { BankImportModule } from '../bank-import/bank-import.module'
// Tier 119: FintsSyncScheduler injects
// CronHealthService for the @Cron body wrap.
import { AdminModule } from '../admin/admin.module'

@Module({
  imports: [PrismaModule, BankImportModule, AdminModule],
  controllers: [FinTsController],
  providers: [FinTsService, FintsSyncScheduler],
  exports: [FinTsService, FintsSyncScheduler],
})
export class FinTsModule {}