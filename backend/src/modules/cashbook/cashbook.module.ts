import { Module } from '@nestjs/common';
import { CashBookController } from './cashbook.controller';
import { KassenbuchService } from './kassenbuch.service';

@Module({
  controllers: [CashBookController],
  providers: [KassenbuchService],
  exports: [KassenbuchService],
})
export class CashBookModule {}
