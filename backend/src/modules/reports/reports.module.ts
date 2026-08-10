import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { UstvaController } from './ustva.controller';
import { ReportsService } from './reports.service';
import { UstvaService } from './ustva.service';
import { UstjaService } from './ustja.service';
import { AgingService } from './aging.service';
import { CashFlowService } from './cashflow.service';
import { PnlService } from './pnl.service';
import { OssService } from './oss.service';
import { BwaService } from './bwa.service';
// Tier 167: DATEV Buchungsliste — per-Sachkonto
// summary + auto revenue-side Sachkonto mapping
// (8120 Reverse Charge / 8125 igL). Same datev.*
// service layer as the existing /datev-export
// endpoint, so no new module deps needed.
import { DatevBuchungslisteService } from './datev-buchungsliste.service';
import { DatevBuchungslisteController } from './datev-buchungsliste.controller';
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
  controllers: [ReportsController, UstvaController, DatevBuchungslisteController],
  providers: [ReportsService, UstvaService, UstjaService, AgingService, CashFlowService, PnlService, OssService, BwaService, DatevBuchungslisteService],
  exports: [ReportsService, UstvaService, UstjaService, AgingService, CashFlowService, PnlService, OssService, BwaService, DatevBuchungslisteService],
})
export class ReportsModule {}
