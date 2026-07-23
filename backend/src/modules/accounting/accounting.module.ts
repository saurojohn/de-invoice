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

@Module({
  imports: [PrismaModule, StorageModule, WebhookModule, AssetsModule],
  controllers: [AccountingController, VoucherTemplateController, JournalController],
  providers: [AccountService, VoucherService, VoucherTemplateService, JournalService, EuerService, AnlageSService, BilanzService, GuVService, AnhangService, BeraterPackagerService, EBilanzService, GobdArchiveService],
  exports: [AccountService, VoucherService, VoucherTemplateService, JournalService, EuerService, AnlageSService, BilanzService, GuVService, AnhangService, BeraterPackagerService, EBilanzService, GobdArchiveService],
})
export class AccountingModule {}