import { Module } from '@nestjs/common'
import { PortalController, InvoicePortalController } from './portal.controller'
import { PortalService } from './portal.service'

@Module({
  controllers: [PortalController, InvoicePortalController],
  providers: [PortalService],
  exports: [PortalService],
})
export class PortalModule {}