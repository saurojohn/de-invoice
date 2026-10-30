import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule], // Tier 740: the delete route checks what a file belongs to
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}