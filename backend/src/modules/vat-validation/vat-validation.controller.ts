/**
 * VatValidationController — HTTP surface for the
 * VIES integration.
 *
 * Routes:
 *   POST /vat-validation/check — body has
 *     { companyId, entityType, entityId, vatId }.
 *     Runs the VIES call, writes a log row,
 *     returns the result + the log id. The
 *     Customer/Supplier form calls this on the
 *     "verify" button.
 *
 *   GET /vat-validation/latest?companyId=…&
 *     entityType=…&entityId=… — fetch the most
 *     recent check for an entity. The detail
 *     pages call this to render the badge on
 *     initial render.
 *
 *   GET /vat-validation/history?companyId=…&
 *     entityType=…&entityId=…&limit=N — list the
 *     recent checks. The detail page's "Verlauf"
 *     tab renders this as a table.
 *
 * Mounted at /api/v1/vat-validation.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { Auth, Require } from '../../auth/roles.decorator';
import {
  VatValidationService,
  VatCheckResult,
} from './vat-validation.service';

interface CheckBody {
  companyId: string;
  entityType: 'customer' | 'supplier';
  entityId: string;
  vatId: string;
}

@Auth()
@Controller('vat-validation')
export class VatValidationController {
  constructor(private service: VatValidationService) {}

  /**
   * Verify a VAT ID against VIES. Used by the
   * Customer/Supplier "USt-ID prüfen" button.
   * Returns the result + the audit log id.
   *
   * Required permission: customer.update OR
   * supplier.update (the user is mid-edit on a
   * record they have write access to). We use
   * the looser of the two — customer.update —
   * because suppliers don't have a dedicated
   * permission yet and we don't want the
   * supplier-edit path to 403.
   */
  @Post('check')
  @Require('customer.update')
  async check(@Body() body: CheckBody): Promise<VatCheckResult & { logId: string }> {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    if (!body?.entityType || (body.entityType !== 'customer' && body.entityType !== 'supplier')) {
      throw new BadRequestException('entityType must be customer or supplier')
    }
    if (!body?.entityId) {
      throw new BadRequestException('entityId is required')
    }
    return this.service.validateAndLog(
      body.companyId,
      body.entityType,
      body.entityId,
      body.vatId || '',
    )
  }

  /**
   * Get the most recent validation result for an
   * entity. Returns null if no check has been
   * performed yet — the UI shows "Ungeprüft" in
   * that case.
   */
  @Get('latest')
  @Require('customer.read')
  async latest(
    @Query('companyId') companyId: string,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    if (!entityType || !entityId) {
      throw new BadRequestException('entityType and entityId are required')
    }
    return this.service.latestForEntity(companyId, entityType, entityId)
  }

  /**
   * List the most recent N validation checks.
   * The detail page's "Verlauf" tab shows the
   * last 20 — that's plenty for a human-readable
   * audit history. We sort newest-first so the
   * most recent (and most relevant) row is on
   * top.
   */
  @Get('history')
  @Require('customer.read')
  async history(
    @Query('companyId') companyId: string,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @Query('limit') limitStr?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    if (!entityType || !entityId) {
      throw new BadRequestException('entityType and entityId are required')
    }
    const limit = Math.min(50, Math.max(1, Number(limitStr) || 20))
    return this.service['prisma'].vatValidationLog.findMany({
      where: { companyId, entityType, entityId },
      orderBy: { checkedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        vatId: true,
        countryCode: true,
        status: true,
        viesName: true,
        errorCode: true,
        errorMessage: true,
        checkedAt: true,
        durationMs: true,
        createdAt: true,
      },
    })
  }
}
