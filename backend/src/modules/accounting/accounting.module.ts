import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AccountingController } from './accounting.controller';
import { AccountService } from './account.service';
import { VoucherService } from './voucher.service';
import { VoucherTemplateService } from './voucher-template.service';
import { VoucherTemplateController } from './voucher-template.controller';
import { JournalService } from './journal.service';
import { JournalController } from './journal.controller';
import { EuerService } from './euer.service';
import { AnlageSService } from './anlage-s.service';
// Tier 92: Anlage V (Vermietung und Verpachtung,
// § 21 EStG). Mirrors the AnlageSService pattern.
import { AnlageVService } from './anlage-v.service';
// Tier 98: Anlage KAP (Kapitalerträge, § 20
// EStG). Sibling of Anlage S + V — covers
// investment income (Zinsen, Dividenden,
// Veräußerungsgewinne). v1 heuristic:
// bank transaction purpose regex.
import { AnlageKAPService } from './anlage-kap.service';
import { BilanzService } from './bilanz.service';
import { GuVService } from './guv.service';
import { AnhangService } from './anhang.service';
import { BeraterPackagerService } from './berater-packager.service';
import { EBilanzService } from './ebilanz.service';
import { GobdArchiveService } from './gobd-archive.service';
import { StorageModule } from '../storage/storage.module';
import { WebhookModule } from '../webhook/webhook.module';
// Tier 83: Anlagenverzeichnis + AfA — the
// AssetsService is injected into the
// BilanzService + GuVService to fill the
// Anlagevermögen (0100-0500) + Abschreibungen
// (7a) positions on the HGB reports.
import { AssetsModule } from '../assets/assets.module';
// Tier 95: ReportsModule provides the BwaService
// that the BeraterPackagerService uses to render
// the BWA PDF in the year-end ZIP. The BWA is
// the monthly operating report; we render
// the December version for the year-end packager
// (Berater can see the full-year summary).
import { ReportsModule } from '../reports/reports.module';

@Module({
  imports: [PrismaModule, StorageModule, WebhookModule, AssetsModule, ReportsModule],
  controllers: [AccountingController, VoucherTemplateController, JournalController],
  providers: [AccountService, VoucherService, VoucherTemplateService, JournalService, EuerService, AnlageSService, AnlageVService, AnlageKAPService, BilanzService, GuVService, AnhangService, BeraterPackagerService, EBilanzService, GobdArchiveService],
  exports: [AccountService, VoucherService, VoucherTemplateService, JournalService, EuerService, AnlageSService, AnlageVService, AnlageKAPService, BilanzService, GuVService, AnhangService, BeraterPackagerService, EBilanzService, GobdArchiveService],
})
export class AccountingModule {}