import { Module } from '@nestjs/common'
import { SigningController } from './signing.controller'
import { SigningService } from './signing.service'
import { PrismaModule } from '../../prisma/prisma.module'

/**
 * Tier 72: PDF Sign + Verify (GoBD § 146 AO).
 *
 * Exports: SigningService — used by the
 * invoice PDF service to embed signatures
 * on download. Controller is mounted at
 * /api/v1/signing/* (cert-info, regenerate,
 * verify-invoice/:id).
 */
@Module({
  controllers: [SigningController],
  providers: [SigningService],
  imports: [PrismaModule],
  exports: [SigningService],
})
export class SigningModule {}
