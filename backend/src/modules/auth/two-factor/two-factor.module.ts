import { Module } from '@nestjs/common'
import { PrismaModule } from '../../../prisma/prisma.module'
import { TwoFactorController } from './two-factor.controller'
import { TwoFactorService } from './two-factor.service'

@Module({
  imports: [PrismaModule],
  controllers: [TwoFactorController],
  providers: [TwoFactorService],
  exports: [TwoFactorService],
})
export class TwoFactorModule {}
