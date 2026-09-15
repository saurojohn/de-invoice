import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Req,
  Headers,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { Request } from 'express'
import { SigningService } from './signing.service'
import { Auth } from '../../auth/roles.decorator'
import { Require } from '../../auth/roles.decorator'
import { AuditService } from '../audit/audit.service'
import { PrismaService } from '../../prisma/prisma.service'
import { SignPdfDto, UserSignPdfDto, VerifyPdfDto } from './dto/signing.dto'

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
 *
 * Tier 207 — RBAC fix. The controller used to
 * have `@Auth()` but no `@Require` on any
 * route, so a VIEWER role (with `UserCompany`
 * access) could:
 *   - call `POST /signing/regenerate` and
 *     destroy the company signing key, and
 *   - call `POST /signing/sign` and sign
 *     arbitrary PDF bytes with the company key.
 * HeaderAuthGuard does check `UserCompany`
 * (so cross-tenant is blocked) but inside-
 * tenant RBAC was completely absent. All four
 * routes now require `company.update`, which
 * is the standard "this mutates the company
 * configuration" permission. The Berater
 * (audit.read) can read cert info via the
 * `GET /companies/:id/audit` style admin
 * endpoints, not via this controller.
 */
@Auth()
@Controller('signing')
export class SigningController {
  constructor(
    private readonly signing: SigningService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Tier 386: a regenerate response carries the certificate data, never the private key. */
  private withoutKey<T extends { key?: string }>(settings: T): Omit<T, 'key'> {
    const { key: _key, ...rest } = settings
    return rest
  }

  /**
   * Tier 386: personal-certificate routes act on the caller or on a member of
   * the caller's company. They took any userId: a freshly registered tenant
   * read another tenant's user's cert info, rotated that user's key (and got
   * the new private key back) and signed a PDF with it.
   */
  private async assertUserInCompany(targetUserId: string, companyId: string, callerId: string) {
    if (targetUserId === callerId) return
    const member = await this.prisma.userCompany.findUnique({
      where: { userId_companyId: { userId: targetUserId, companyId } },
      select: { userId: true },
    })
    if (!member) throw new NotFoundException('Benutzer nicht gefunden')
  }

  @Get('cert-info')
  @Require('company.update')
  async certInfo(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.signing.getCertInfo(companyId)
  }

  @Post('regenerate')
  @Require('company.update')
  async regenerate(
    @Req() req: Request,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    // Tier 207 — write a writeActivity
    // audit row for the destructive
    // cert-rotation event. Pre-fix this
    // regenerated silently with no
    // audit trail (the signing key is
    // a GoBD-relevant artifact).
    const userId = (req as any).user?.id || null
    await this.audit.writeActivity({
      companyId,
      userId,
      action: 'signing.regenerate',
      entityType: 'SigningKey',
      entityId: companyId,
      metadata: { source: 'manual_api_call' },
    })
    return this.withoutKey(await this.signing.regenerate(companyId))
  }

  @Post('sign')
  @Require('company.update')
  async sign(
    @Body() body: SignPdfDto,
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
  @Require('company.update')
  async verify(@Body() body: VerifyPdfDto) {
    if (!body?.pdf) {
      throw new BadRequestException('pdf (base64) ist erforderlich')
    }
    const pdf = Buffer.from(body.pdf, 'base64')
    return this.signing.verifyPdf(pdf)
  }

  // ─── Tier 246: per-User signing (Berater personal cert) ───
  //
  // The company cert (above) auto-signs every PDF.
  // The user cert is the opt-in Berater stamp that
  // adds a second signature in the chain (Adobe
  // Reader renders both). All endpoints require the
  // same `company.update` permission — the Berater
  // signs their own PDFs; the admin can also force
  // a rotation via `user-regenerate`.

  @Get('user-cert-info')
  @Require('company.update')
  async userCertInfo(
    @Req() req: Request,
    @Headers('x-company-id') companyId: string,
    @Query('userId') userId: string,
  ) {
    if (!userId) throw new BadRequestException('userId ist erforderlich')
    await this.assertUserInCompany(userId, companyId, (req as any).user?.id)
    return this.signing.getUserCertInfo(userId)
  }

  @Post('user-regenerate')
  @Require('company.update')
  async userRegenerate(
    @Req() req: Request,
    @Headers('x-company-id') companyId: string,
    @Query('userId') userId: string,
  ) {
    if (!userId) throw new BadRequestException('userId ist erforderlich')
    const actorId = (req as any).user?.id || null
    await this.assertUserInCompany(userId, companyId, actorId)
    await this.audit.writeActivity({
      // the active company (User.companyId is only the user's default one)
      companyId,
      userId: actorId,
      action: 'signing.user_regenerate',
      entityType: 'UserSigningKey',
      entityId: userId,
      metadata: { targetUserId: userId },
    })
    return this.withoutKey(await this.signing.regenerateUser(userId))
  }

  @Post('user-sign')
  @Require('company.update')
  async userSign(@Req() req: Request, @Body() body: UserSignPdfDto) {
    // A signature names a person: only the caller's own certificate.
    const userId = (req as any).user?.id as string
    if (body.userId !== userId) {
      throw new ForbiddenException('Nur mit dem eigenen Zertifikat signieren')
    }
    if (!body?.pdf) {
      throw new BadRequestException('pdf (base64) ist erforderlich')
    }
    const pdf = Buffer.from(body.pdf, 'base64')
    const signed = await this.signing.signPdfAsUser(userId, pdf)
    const cert = await this.signing.getUserCertInfo(userId)
    return {
      signedPdf: signed.toString('base64'),
      fingerprint: cert.fingerprint,
      commonName: cert.commonName,
      validUntil: cert.validUntil,
    }
  }
}
