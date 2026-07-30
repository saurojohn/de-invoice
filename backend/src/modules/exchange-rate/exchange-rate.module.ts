import { Module } from '@nestjs/common'
import { ExchangeRateService } from './exchange-rate.service'
import { ExchangeRateController } from './exchange-rate.controller'
// Tier 119: ExchangeRateService injects
// CronHealthService (for the @Cron body wrap).
import { AdminModule } from '../admin/admin.module'

@Module({
  imports: [AdminModule],
  controllers: [ExchangeRateController],
  providers: [ExchangeRateService],
  exports: [ExchangeRateService],
})
export class ExchangeRateModule {}
