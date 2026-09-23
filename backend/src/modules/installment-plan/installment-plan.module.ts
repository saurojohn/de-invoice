import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { InstallmentPlanController } from './installment-plan.controller'
import { InstallmentPlanService } from './installment-plan.service'
import { InvoiceModule } from '../invoice/invoice.module'

/**
 * Tier 51: Ratenzahlung (installment payment plans).
 * Mounted at /api/v1/installment-plans.
 */
@Module({
  imports: [PrismaModule, InvoiceModule],
  controllers: [InstallmentPlanController],
  providers: [InstallmentPlanService],
  exports: [InstallmentPlanService],
})
export class InstallmentPlanModule {}
