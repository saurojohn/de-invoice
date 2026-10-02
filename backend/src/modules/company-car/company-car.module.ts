import { Module } from '@nestjs/common'
import { CompanyCarController } from './company-car.controller'
import { CompanyCarService } from './company-car.service'

/** Tier 502 */
@Module({
  controllers: [CompanyCarController],
  providers: [CompanyCarService],
  exports: [CompanyCarService],
})
export class CompanyCarModule {}
