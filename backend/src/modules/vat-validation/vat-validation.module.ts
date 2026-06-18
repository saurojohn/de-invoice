import { Global, Module } from '@nestjs/common';
import { VatValidationController } from './vat-validation.controller';
import { VatValidationService } from './vat-validation.service';
import { VatReverifyScheduler } from './vat-reverify.scheduler';
import { VatAuditPdfService } from './vat-audit-pdf.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';

@Global()
@Module({
  imports: [PrismaModule, MailModule],
  controllers: [VatValidationController],
  providers: [VatValidationService, VatReverifyScheduler, VatAuditPdfService],
  exports: [VatValidationService, VatAuditPdfService],
})
export class VatValidationModule {}
