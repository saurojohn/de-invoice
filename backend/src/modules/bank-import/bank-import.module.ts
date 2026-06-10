import { Module } from '@nestjs/common';
import { BankImportController } from './bank-import.controller';
import { BankImportService } from './bank-import.service';

@Module({
  controllers: [BankImportController],
  providers: [BankImportService],
  exports: [BankImportService],
})
export class BankImportModule {}
