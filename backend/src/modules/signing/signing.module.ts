import { Module } from '@nestjs/common'
import { SigningController } from './signing.controller'
import { SigningService } from './signing.service'
import { PrismaModule } from '../../prisma/prisma.module'
import { AuditModule } from '../audit/audit.module'

/**
 * Tier 72: PDF Sign + Verify (GoBD § 146 AO).
 *
 * Exports: SigningService — used by the
 * invoice PDF service to embed signatures
 * on download. Controller is mounted at
 * /api/v1/signing/* (cert-info, regenerate,
 * verify-invoice/:id).
 *
 * Tier 207 — AuditModule imported so the
 * `regenerate` endpoint can write a
 * `signing.regenerate` activity row (the
 * signing cert is a GoBD-relevant artifact;
 * rotation must be auditable).
 */
@Module({
  controllers: [SigningController],
  providers: [SigningService],
  imports: [PrismaModule, AuditModule],
  exports: [SigningService],
})
export class SigningModule {}
