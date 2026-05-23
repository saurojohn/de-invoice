import { Module } from '@nestjs/common';
import { VatRateController } from './vat-rate.controller';
import { VatRateService } from './vat-rate.service';

@Module({
  controllers: [VatRateController],
  providers: [VatRateService],
  exports: [VatRateService],
})
export class VatRateModule {}
