import { Module } from '@nestjs/common'
import { HealthController } from './health.controller'
import { MetricsController } from './metrics.controller'
import { PrismaModule } from '../../prisma/prisma.module'

@Module({
  imports: [PrismaModule],
  controllers: [HealthController, MetricsController],
})
export class HealthModule {}