import { Module } from '@nestjs/common'
import { BeraterController } from './berater.controller'
import { BeraterService } from './berater.service'
import { AttachmentsModule } from '../attachment/attachments.module'
import { StorageModule } from '../storage/storage.module'

/**
 * Tier 79: Berater Document Exchange module.
 *
 * The Berater (role='berater' on UserCompany)
 * needs a write-back channel to the Mandant.
 * Tier 66 + 71 gave them read access; this
 * module adds the counterpart — the Berater
 * can leave notes + upload supporting documents
 * (Belege, Korrekturen) on specific records and
 * the Mandant sees them in a queue and can
 * acknowledge or dismiss.
 *
 * The Berater does NOT get write access to the
 * underlying bookkeeping data — only to this
 * dedicated "berater" namespace. Role boundary
 * checks live in BeraterService.create /
 * acknowledge / dismiss, not the controller
 * (the @Require decorator can't express "only
 * this exact role" + "only NOT this exact
 * role").
 */
@Module({
  imports: [AttachmentsModule, StorageModule],
  controllers: [BeraterController],
  providers: [BeraterService],
  exports: [BeraterService],
})
export class BeraterModule {}
