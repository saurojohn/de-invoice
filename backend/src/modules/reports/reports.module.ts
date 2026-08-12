import { Module } from '@nestjs/common';
// Tier 173 split: the original 2455-line
// reports.controller.ts was split into 7
// domain-specific controllers. All 7 share
// the `@Controller('reports')` prefix so the
// frontend URL paths are unchanged. The
// UstvaController + DatevBuchungslisteController
// were already separate (Tiers 161/162/163/167)
// — we leave them as-is and add the 7 new
// controllers next to them.
import { SalesReportController } from './sales-report.controller';
import { DashboardController } from './dashboard.controller';
import { DatevExportController } from './datev-export.controller';
import { CashflowPnlController } from './cashflow-pnl.controller';
import { BwaController } from './bwa.controller';
import { OssController } from './oss.controller';
import { CostCenterController } from './cost-center.controller';
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
  controllers: [
    // Tier 173 split — the 7 new controllers
    // each own a domain, all share the
    // `reports` URL prefix. Order is irrelevant
    // (Nest registers them in parallel; first
    // match wins per route).
    SalesReportController,
    DashboardController,
    DatevExportController,
    CashflowPnlController,
    BwaController,
    OssController,
    CostCenterController,
    // Pre-existing splits from earlier tiers.
    UstvaController, // Tier 161
    DatevBuchungslisteController, // Tier 167
  ],
  providers: [
    ReportsService,
    UstvaService,
    UstjaService,
    AgingService,
    CashFlowService,
    PnlService,
    OssService,
    BwaService,
    DatevBuchungslisteService,
  ],
  exports: [
    ReportsService,
    UstvaService,
    UstjaService,
    AgingService,
    CashFlowService,
    PnlService,
    OssService,
    BwaService,
    DatevBuchungslisteService,
  ],
})
export class ReportsModule {}
