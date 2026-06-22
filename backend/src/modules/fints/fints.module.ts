import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { FinTsController } from './fints.controller'
import { FinTsService } from './fints.service'
import { FintsSyncScheduler } from './fints-sync.scheduler'

@Module({
  imports: [PrismaModule],
  controllers: [FinTsController],
  providers: [FinTsService, FintsSyncScheduler],
  exports: [FinTsService, FintsSyncScheduler],
})
export class FinTsModule {}
