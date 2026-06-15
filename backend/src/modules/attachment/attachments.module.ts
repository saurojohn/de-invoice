/**
 * Attachments module — wires the service + controller
 * + OCR service + storage service together.
 *
 * The module is global (decorated with @Global) so
 * any feature module (expense, voucher, future
 * invoice) can import AttachmentsService without
 * re-declaring the dependency in its own @Module.
 *
 * The StorageModule is already global (see
 * modules/storage/storage.module.ts), so importing
 * it here is redundant but explicit — it documents
 * the dependency.
 */
import { Global, Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { OcrService } from './ocr.service';
import { StorageModule } from '../storage/storage.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, OcrService],
  exports: [AttachmentsService, OcrService],
})
export class AttachmentsModule {}
