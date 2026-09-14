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
 *   POST /vat-validation/batch-check — body has
 *     { companyId, entityType, limit? }. Walks
 *     every customer/supplier with a VAT ID and
 *     runs validateAndLog on each. Used by the
 *     "Alle USt-IDs prüfen" button on the
 *     customers/suppliers list pages. Slow
 *     (1-2 min for 50 entities) — the frontend
 *     shows a progress modal.
 *
 * Mounted at /api/v1/vat-validation.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Auth, Require } from '../../auth/roles.decorator';
import {
  VatReverifyScheduler,
} from './vat-reverify.scheduler'
import { VatValidationService,
  VatCheckResult,
} from './vat-validation.service';
import { VatAuditPdfService } from './vat-audit-pdf.service';

interface CheckBody {
  companyId: string;
  entityType: 'customer' | 'supplier';
  entityId: string;
  vatId: string;
}

@Auth()
@Controller('vat-validation')
export class VatValidationController {
  constructor(
    private service: VatValidationService,
    private reverifyScheduler: VatReverifyScheduler,
    private auditPdfService: VatAuditPdfService,
  ) {}

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

  /**
   * Tier 134: batch-check every customer/supplier
   * with a VAT ID. Used by the "Alle USt-IDs prüfen"
   * button on the list pages. Capped at 100 entities
   * (1-2 min) and rate-limited 1/min per company so
   * a double-click doesn't trigger two parallel
   * batches. The frontend shows a progress modal
   * while this is in flight.
   *
   * Returns: { total, valid, invalid, unreachable,
   * skipped, durationMs, results: [...] }.
   *
   * Permission: customer.update (same as the
   * per-entity check).
   */
  @Post('batch-check')
  @Require('customer.update')
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  async batchCheck(
    @Body() body: {
      companyId: string
      entityType?: 'customer' | 'supplier'
      limit?: number
    },
  ) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    const entityType = body.entityType === 'supplier' ? 'supplier' : 'customer'
    return this.service.batchCheckAll(body.companyId, entityType, {
      limit: body.limit,
    })
  }

  /**
   * Dev / admin trigger: run the nightly
   * VIES re-verify now (bypasses DISABLE_CRON
   * and the 02:00 schedule). Returns the same
   * stats the cron logs at the end of a real run.
   * Useful for soak-testing the verification
   * pipeline and for letting a user force a
   * refresh of all their customer/supplier
   * VAT status on demand.
   *
   * Not rate-limited because (a) it's an admin
   * endpoint and (b) the underlying cron is
   * already rate-limited via VatValidationService.
   */
  @Post('reverify-now')
  @Require('users.read')  // admin-only (accountants can NOT trigger a full re-verify)
  async reverifyNow() {
    return this.reverifyScheduler.runNowForTest()
  }

  /**
   * USt-ID-Audit PDF — single-PDF report of every
   * VIES check this company has run, grouped by
   * customer / supplier. Intended for the
   * Steuerberater to attach to the UStVA
   * Vorbereitung as evidence that business
   * partners were validated.
   *
   * Query params:
   *   companyId (required)
   *   fromDate  (optional ISO date, default = 1y ago)
   *   toDate    (optional ISO date, default = now)
   *
   * Permission: any user with company.read can
   * request this — the data is not sensitive
   * (it's the same data the UI already shows in
   * each entity's "Verlauf" tab). The PDF just
   * collates it.
   */
  @Require('customer.read')
  @Get('audit.pdf')
  // @Require deliberately omitted: this report
  // collates the same data each user can already
  // see per-entity in the UI (Verlauf tab). Any
  // authenticated user with customer.read
  // permission can request it. We use the
  // HeaderAuthGuard (set by @Auth() at the
  // controller level) to verify authentication.
  async auditPdf(
    @Res({ passthrough: false }) res: any,
    @Query('companyId') companyId: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const pdf = await this.auditPdfService.generate(companyId, {
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
    })
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="ust-id-audit-${companyId.slice(0, 8)}.pdf"`,
      'Content-Length': pdf.length,
    })
    res.end(pdf)
  }
}
