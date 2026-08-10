import { Module } from '@nestjs/common'
import { GobdExportService } from './gobd-export.service'
import { GobdExportController } from './gobd-export.controller'
import { PrismaModule } from '../../prisma/prisma.module'
import { StorageModule } from '../storage/storage.module'
import { SigningModule } from '../signing/signing.module'

@Module({
  controllers: [GobdExportController],
  providers: [GobdExportService],
  imports: [PrismaModule, StorageModule, SigningModule],
  exports: [GobdExportService],
})
export class GobdExportModule {}
