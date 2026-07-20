import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { UstvaController } from './ustva.controller';
import { ReportsService } from './reports.service';
import { UstvaService } from './ustva.service';
import { AgingService } from './aging.service';
import { CashFlowService } from './cashflow.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [ReportsController, UstvaController],
  providers: [ReportsService, UstvaService, AgingService, CashFlowService],
  exports: [ReportsService, UstvaService, AgingService, CashFlowService],
})
export class ReportsModule {}
