import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { FinTsController } from './fints.controller'
import { FinTsService } from './fints.service'

@Module({
  imports: [PrismaModule],
  controllers: [FinTsController],
  providers: [FinTsService],
  exports: [FinTsService],
})
export class FinTsModule {}
