import { Global, Module } from '@nestjs/common';
import { VatValidationController } from './vat-validation.controller';
import { VatValidationService } from './vat-validation.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [VatValidationController],
  providers: [VatValidationService],
  exports: [VatValidationService],
})
export class VatValidationModule {}
