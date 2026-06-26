import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AccountingController } from './accounting.controller';
import { AccountService } from './account.service';
import { VoucherService } from './voucher.service';
import { VoucherTemplateService } from './voucher-template.service';
import { VoucherTemplateController } from './voucher-template.controller';
import { JournalService } from './journal.service';
import { JournalController } from './journal.controller';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [PrismaModule, WebhookModule],
  controllers: [AccountingController, VoucherTemplateController, JournalController],
  providers: [AccountService, VoucherService, VoucherTemplateService, JournalService],
  exports: [AccountService, VoucherService, VoucherTemplateService, JournalService],
})
export class AccountingModule {}