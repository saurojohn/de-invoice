import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  BadRequestException,
} from '@nestjs/common'
import { SigningService } from './signing.service'
import { Auth } from '../../auth/roles.decorator'
import { PrismaService } from '../../prisma/prisma.service'

/**
 * Tier 72: Signing HTTP API.
 *
 * Endpoints:
 *   GET  /api/v1/signing/cert-info?companyId=...
 *     → { commonName, fingerprint, validUntil, generatedAt }
 *
 *   POST /api/v1/signing/regenerate?companyId=...
 *     → { commonName, fingerprint, validUntil, generatedAt }
 *     (force a new self-signed cert; the old
 *     one is replaced and signatures from the
 *     old cert will not verify against the
 *     new one)
 *
 *   POST /api/v1/signing/sign
 *     body: { companyId, pdf (base64) }
 *     → { signedPdf (base64), fingerprint, commonName, validUntil }
 *     Signs an arbitrary PDF the client
 *     already has. This is the path the
 *     invoice PDF endpoint uses internally
 *     to embed a signature into the download
 *     stream.
 *
 *   POST /api/v1/signing/verify
 *     body: { pdf (base64) }
 *     → { valid, signedBy, certFingerprint, reason, signatureCount }
 *     Verifies an arbitrary PDF the client
 *     just downloaded (or one a third party
 *     sent the user to verify).
 *
 * No "verify-invoice/:id" shortcut for v1 —
 * the verify path is generic on the PDF
 * bytes, and the frontend can wire the
 * "verify the just-downloaded invoice" flow
 * with a single round-trip: download PDF,
 * POST it back to /verify.
 */
@Auth()
@Controller('signing')
export class SigningController {
  constructor(
    private readonly signing: SigningService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('cert-info')
  async certInfo(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.signing.getCertInfo(companyId)
  }

  @Post('regenerate')
  async regenerate(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.signing.regenerate(companyId)
  }

  @Post('sign')
  async sign(
    @Body() body: { companyId?: string; pdf?: string },
  ) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!body?.pdf) {
      throw new BadRequestException('pdf (base64) ist erforderlich')
    }
    const pdf = Buffer.from(body.pdf, 'base64')
    const signed = await this.signing.signPdf(body.companyId, pdf)
    const cert = await this.signing.getCertInfo(body.companyId)
    return {
      signedPdf: signed.toString('base64'),
      fingerprint: cert.fingerprint,
      commonName: cert.commonName,
      validUntil: cert.validUntil,
    }
  }

  @Post('verify')
  async verify(@Body() body: { pdf?: string }) {
    if (!body?.pdf) {
      throw new BadRequestException('pdf (base64) ist erforderlich')
    }
    const pdf = Buffer.from(body.pdf, 'base64')
    return this.signing.verifyPdf(pdf)
  }
}
