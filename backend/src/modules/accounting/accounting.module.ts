import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AccountingController } from './accounting.controller';
import { AccountService } from './account.service';
import { VoucherService } from './voucher.service';
import { VoucherTemplateService } from './voucher-template.service';
import { VoucherTemplateController } from './voucher-template.controller';

@Module({
  imports: [PrismaModule],
  controllers: [AccountingController, VoucherTemplateController],
  providers: [AccountService, VoucherService, VoucherTemplateService],
  exports: [AccountService, VoucherService, VoucherTemplateService],
})
export class AccountingModule {}