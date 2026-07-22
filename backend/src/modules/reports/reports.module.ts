import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { UstvaController } from './ustva.controller';
import { ReportsService } from './reports.service';
import { UstvaService } from './ustva.service';
import { AgingService } from './aging.service';
import { CashFlowService } from './cashflow.service';
import { PnlService } from './pnl.service';
import { OssService } from './oss.service';
import { BwaService } from './bwa.service';
import { StorageModule } from '../storage/storage.module';
// Tier 86: BWA needs AssetsService for the
// per-asset AfA → GKV 3100 line. Importing
// AssetsModule here creates a circular
// dependency (AssetsModule doesn't import
// ReportsModule, so this is safe — Nest
// handles the forwardRef if needed but
// AssetsModule doesn't depend on us).
import { AssetsModule } from '../assets/assets.module';

@Module({
  imports: [StorageModule, AssetsModule],
  controllers: [ReportsController, UstvaController],
  providers: [ReportsService, UstvaService, AgingService, CashFlowService, PnlService, OssService, BwaService],
  exports: [ReportsService, UstvaService, AgingService, CashFlowService, PnlService, OssService, BwaService],
})
export class ReportsModule {}
