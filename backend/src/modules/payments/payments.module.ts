import { Module } from '@nestjs/common'
import { PaymentsController } from './payments.controller'
import { PaymentsService } from './payments.service'
import { DirectDebitController } from './direct-debit.controller'
import { DirectDebitService } from './direct-debit.service'

@Module({
  controllers: [PaymentsController, DirectDebitController],
  providers: [PaymentsService, DirectDebitService],
  exports: [PaymentsService, DirectDebitService],
})
export class PaymentsModule {}
