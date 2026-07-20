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
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [PrismaModule, WebhookModule],
  controllers: [AccountingController, VoucherTemplateController, JournalController],
  providers: [AccountService, VoucherService, VoucherTemplateService, JournalService, EuerService],
  exports: [AccountService, VoucherService, VoucherTemplateService, JournalService, EuerService],
})
export class AccountingModule {}