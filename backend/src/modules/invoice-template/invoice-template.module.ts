import { Module } from '@nestjs/common'
import { PrismaModule } from '../../prisma/prisma.module'
import { InvoiceTemplateController } from './invoice-template.controller'
import { InvoiceTemplateService } from './invoice-template.service'

@Module({
  imports: [PrismaModule],
  controllers: [InvoiceTemplateController],
  providers: [InvoiceTemplateService],
  exports: [InvoiceTemplateService],
})
export class InvoiceTemplateModule {}
