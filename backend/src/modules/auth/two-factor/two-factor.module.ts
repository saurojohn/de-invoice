import { Module } from '@nestjs/common'
import { PrismaModule } from '../../../prisma/prisma.module'
import { TwoFactorController } from './two-factor.controller'
import { TwoFactorService } from './two-factor.service'
import { AuditModule } from '../../audit/audit.module'

@Module({
  imports: [PrismaModule, AuditModule], // Tier 861: the policy change is audited
  controllers: [TwoFactorController],
  providers: [TwoFactorService],
  exports: [TwoFactorService],
})
export class TwoFactorModule {}
