import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { UstvaController } from './ustva.controller';
import { ReportsService } from './reports.service';
import { UstvaService } from './ustva.service';
import { AgingService } from './aging.service';

@Module({
  controllers: [ReportsController, UstvaController],
  providers: [ReportsService, UstvaService, AgingService],
  exports: [ReportsService, UstvaService, AgingService],
})
export class ReportsModule {}
