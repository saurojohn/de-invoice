import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { AssetsController } from './assets.controller'
import { AssetsService } from './assets.service'
import { AfaAutoBookerScheduler } from './afa-auto-booker.scheduler'

@Module({
  imports: [PrismaModule],
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
