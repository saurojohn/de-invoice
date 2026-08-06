import { Module } from '@nestjs/common'
import { NoteTemplateController } from './note-template.controller'
import { NoteTemplateService } from './note-template.service'
import { PrismaModule } from '../../prisma/prisma.module'

@Module({
  controllers: [NoteTemplateController],
  providers: [NoteTemplateService],
  imports: [PrismaModule],
  exports: [NoteTemplateService],
})
export class NoteTemplateModule {}
