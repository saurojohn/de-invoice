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
import { AnlageKAPService } from './anlage-kap.service'
// Tier 100: Anlage G (Gewerbebetrieb, § 15
// EStG). The 4th Anlage form — for gewerbliche
// Einzelunternehmen + Personengesellschaften.
// Pairs with EÜR — adds § 8/9 GewStG Hinzu-/
// Kürzungen on top of the EÜR sum.
import { AnlageGService } from './anlage-g.service'
// Tier 101: Anlage N (Arbeitnehmereinkünfte,
// § 3 EStG). The 5th Anlage form — for
// Arbeitnehmer + Beamte + Teilzeit-Beschäftigte.
// Data: Lohnsteuerbescheinigung + manual
// Werbungskosten/Sonderausgaben/aB.
import { AnlageNService } from './anlage-n.service'
// Tier 102: KSt 1 (Körperschaftsteuererklärung,
// § 1 Abs. 1 KStG). The PRIMARY tax form for
// Kapitalgesellschaften (GmbH, AG, KGaA).
// Pairs with the E-Bilanz for the Jahresabschluss-
// based filing. Reads the G+V Jahresüberschuss
// from GuVService and applies the standard
// KSt + GewSt + Anrechnung formula.
import { KSt1Service } from './kst1.service'
// Tier 103: Anlage R (Einkünfte aus Renten und
// Bezügen, § 22 EStG). The 6th Anlage form —
// for retirees / pension recipients. Covers
// DRV, BAV, Riester, Rürup, private Rente.
// Besteuerungsanteil from BMF table per year.
import { AnlageRService } from './anlage-r.service'
// Tier 104: Anlage Kind (Kinderfreibetrag +
// Kindergeld, § 32 / § 33 / § 33a EStG). The
// 7th Anlage form — for families with children.
// Data: list of children per year (name +
// birthDate + kindergeldEligible).
import { AnlageKindService } from './anlage-kind.service';
// Tier 109: Anlage SO (Sonstige Einkünfte,
// § 22 EStG). The 8th Anlage form — catch-all
// for private Veräußerungsgeschäfte (Krypto /
// Gold / Aktien innerhalb Spekulationsfrist) +
// wiederkehrende Bezüge. Freigrenze 600 EUR/Jahr
// (§ 23 Abs. 3 Satz 5 EStG).
import { AnlageSOService } from './anlage-so.service';
// Tier 110: Anlage AUS (Ausländische Einkünfte,
// § 34d EStG). The 9th Anlage form — the
// international dimension. Freistellung vs
// Anrechnung per DBA, § 8b KStG for KapG
// dividends, Progressionsvorbehalt for
// DBA-exempt income.
import { AnlageAUSService } from './anlage-aus.service';
// Tier 106: GewSt-Erklärung (Gewerbesteuererklärung,
// BMF Vordruck GewSt 1A 2024). Reuses AnlageGService
// for the underlying gewerbeertrag + hebesatz.
import { GewstService } from './gewst.service';
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
  providers: [AccountService, VoucherService, VoucherTemplateService, JournalService, EuerService, AnlageSService, AnlageVService, AnlageKAPService, AnlageGService, AnlageNService, KSt1Service, AnlageRService, AnlageKindService, AnlageSOService, AnlageAUSService, GewstService, BilanzService, GuVService, AnhangService, BeraterPackagerService, EBilanzService, GobdArchiveService],
  exports: [AccountService, VoucherService, VoucherTemplateService, JournalService, EuerService, AnlageSService, AnlageVService, AnlageKAPService, AnlageGService, AnlageNService, KSt1Service, AnlageRService, AnlageKindService, AnlageSOService, AnlageAUSService, GewstService, BilanzService, GuVService, AnhangService, BeraterPackagerService, EBilanzService, GobdArchiveService],
})
export class AccountingModule {}