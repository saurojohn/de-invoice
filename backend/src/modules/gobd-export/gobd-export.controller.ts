import {
  Controller,
  Get,
  Query,
  Res,
  BadRequestException,
  Logger,
} from '@nestjs/common'
import type { Response } from 'express'
import { GobdExportService } from './gobd-export.service'
import { Auth, Require } from '../../auth/roles.decorator'

/**
 * Tier 166: GoBD § 147 AO archive export — HTTP API.
 *
 * Endpoint:
 *
 *   GET /api/v1/gobd-export?companyId=...&year=YYYY[&month=M]
 *
 * Tier 181 adds the optional `month` query param.
 * When set, the archive is scoped to that single
 * month (e.g. `&month=7` → 2026-07-01..2026-07-31 UTC).
 * The filename becomes
 *   `GoBD-2026-07-CompanyName-YYYY-MM-DD.zip`
 * so the Berater's archive folder sorts naturally
 * alongside the per-month UStVA-PDF (Tier 177).
 *
 * Requires `audit.read` (admin / accountant /
 * berater). The same role that can see the
 * audit log can produce a Steuerprüfer
 * archive — a `viewer` cannot.
 *
 * Response:
 *   - application/zip
 *   - Content-Disposition: attachment;
 *     filename="GoBD-YYYY-CompanyName-YYYY-MM-DD.zip"
 *     (or "GoBD-YYYY-MM-…zip" when month is set)
 *   - X-GoBD-Stats: JSON header with the per-section
 *     counts so the UI can show "✓ 234 invoices,
 *     7 Mahnungen, 1523 audit rows" without
 *     downloading + unzipping.
 *
 * Failure modes:
 *   - 400 if year is missing or out of range
 *   - 400 if month is set but out of range (1-12)
 *   - 400 if companyId is missing
 *   - 500 if the Prisma queries fail (e.g.
 *     DB down); the underlying service throws
 *     and Nest's GlobalExceptionFilter
 *     translates.
 *
 * Synchronous for v1. For >500 invoices the
 * build is O(seconds) and streams a few MB
 * through memory — fine for a one-shot
 * Berater click. v2 (if anyone ever hits the
 * limit) would move to a background job +
 * download URL.
 */
@Auth()
@Controller('gobd-export')
export class GobdExportController {
  private readonly logger = new Logger(GobdExportController.name)

  constructor(private readonly svc: GobdExportService) {}

  @Get()
  @Require('audit.read')
  async export(
    @Query('companyId') companyId: string,
    @Query('year') yearParam: string | undefined,
    @Query('month') monthParam: string | undefined,
    @Res() res: Response,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!yearParam) {
      throw new BadRequestException('year ist erforderlich (z.B. 2026)')
    }
    const year = parseInt(yearParam, 10)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException(
        `Ungültiges Jahr: ${yearParam} (2000-2100)`,
      )
    }
    // Tier 181: optional month. month=0 / month=13
    // → 400 with a German explanation. Empty string
    // is treated as "no month" (some HTTP clients
    // emit `&month=` for absent values).
    let month: number | undefined
    if (monthParam !== undefined && monthParam !== '') {
      month = parseInt(monthParam, 10)
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new BadRequestException(
          `Ungültiger Monat: ${monthParam} (1-12)`,
        )
      }
    }

    const t0 = Date.now()
    const result = await this.svc.buildArchive({ companyId, year, month })
    const ms = Date.now() - t0
    this.logger.log(
      `Built GoBD export for ${companyId} year=${year} in ${ms}ms: ` +
        `invoices=${result.stats.invoices}, ` +
        `creditNotes=${result.stats.creditNotes}, ` +
        `mahnungen=${result.stats.mahnungen}, ` +
        `recurrings=${result.stats.recurrings}, ` +
        `emails=${result.stats.emailSends}, ` +
        `auditRows=${result.stats.auditLogRows}, ` +
        `signedPdfs=${result.stats.signedPdfs}/${result.stats.signedPdfs + result.stats.unsignedPdfs}, ` +
        `size=${result.stats.totalSize}B`,
    )

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Length': String(result.zipBuffer.length),
      'X-GoBD-Stats': JSON.stringify(result.stats),
      'X-GoBD-Generation-Ms': String(ms),
    })
    res.end(result.zipBuffer)
  }
}
