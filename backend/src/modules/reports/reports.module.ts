import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { UstvaController } from './ustva.controller';
import { ReportsService } from './reports.service';
import { UstvaService } from './ustva.service';

@Module({
  controllers: [ReportsController, UstvaController],
  providers: [ReportsService, UstvaService],
  exports: [ReportsService, UstvaService],
})
export class ReportsModule {}
