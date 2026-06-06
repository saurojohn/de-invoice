import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AccountingController } from './accounting.controller';
import { AccountService } from './account.service';
import { VoucherService } from './voucher.service';

@Module({
  imports: [PrismaModule],
  controllers: [AccountingController],
  providers: [AccountService, VoucherService],
  exports: [AccountService, VoucherService],
})
export class AccountingModule {}