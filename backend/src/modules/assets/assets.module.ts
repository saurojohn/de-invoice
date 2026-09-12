import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { AssetsController } from './assets.controller'
import { AssetsService } from './assets.service'
import { AfaAutoBookerScheduler } from './afa-auto-booker.scheduler'
// Tier 119: AfaAutoBookerScheduler injects
// CronHealthService for the @Cron body wrap.
import { AdminModule } from '../admin/admin.module'
// Tier 368: AuditService signs the AfA storno / auto-book audit rows, which
// used to be written unsigned via prisma.auditLog.create.
import { AuditModule } from '../audit/audit.module'

@Module({
  imports: [PrismaModule, AdminModule, AuditModule],
  controllers: [AssetsController],
  providers: [
    AssetsService,
    // Tier 91: auto-AfA month-end scheduler.
    // Registered in the same module so it
    // shares the AssetsService instance +
    // PrismaService.
    AfaAutoBookerScheduler,
  ],
  exports: [AssetsService],
})
export class AssetsModule {}
