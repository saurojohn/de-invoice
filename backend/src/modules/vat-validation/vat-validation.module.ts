import { Global, Module } from '@nestjs/common';
import { VatValidationController } from './vat-validation.controller';
import { VatValidationService } from './vat-validation.service';
import { VatReverifyScheduler } from './vat-reverify.scheduler';
import { VatAuditPdfService } from './vat-audit-pdf.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
// Tier 119: VatReverifyScheduler injects
// CronHealthService for the @Cron body wrap.
import { AdminModule } from '../admin/admin.module';

@Global()
@Module({
  imports: [PrismaModule, MailModule, AdminModule],
  controllers: [VatValidationController],
  providers: [VatValidationService, VatReverifyScheduler, VatAuditPdfService],
  exports: [VatValidationService, VatAuditPdfService],
})
export class VatValidationModule {}
