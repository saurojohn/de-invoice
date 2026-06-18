import { Global, Module } from '@nestjs/common';
import { VatValidationController } from './vat-validation.controller';
import { VatValidationService } from './vat-validation.service';
import { VatReverifyScheduler } from './vat-reverify.scheduler';
import { PrismaModule } from '../../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';

@Global()
@Module({
  imports: [PrismaModule, MailModule],
  controllers: [VatValidationController],
  providers: [VatValidationService, VatReverifyScheduler],
  exports: [VatValidationService],
})
export class VatValidationModule {}
