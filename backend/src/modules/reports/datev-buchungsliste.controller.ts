import {
  Controller,
  Get,
  Query,
  Res,
  BadRequestException,
  Logger,
} from '@nestjs/common'
import type { Response } from 'express'
import { DatevBuchungslisteService } from './datev-buchungsliste.service'
import { Auth, Require } from '../../auth/roles.decorator'

/**
 * Tier 167: DATEV Buchungsliste (per-Sachkonto
 * summary) HTTP API.
 *
 *   GET /api/v1/reports/datev-buchungsliste?
 *     companyId=...
 *     &year=YYYY
 *     [&month=1-12]
 *
 * Returns application/zip with:
 *   - Buchungsliste.csv    (per-Sachkonto summary)
 *   - Buchungsstapel.csv   (raw DATEV ledger)
 *   - USt-Verprobung.csv   (per USt-Schlüssel)
 *   - Kontenplan.csv       (active Sachkonten +
 *                            SKR03 default names)
 *   - manifest.json        (per-file sha256 +
 *                            self-hash per BSI
 *                            TR-03127 §4.3)
 *
 * Requires `reports.read` (admin /
 * accountant / berater). Same role that
 * already has access to the existing
 * /reports/datev-export endpoint.
 *
 * The response carries an `X-Buchungsliste-
 * Stats` header with the per-section counts
 * so the UI can show "234 Buchungen, 15
 * Sachkonten, 4 USt-Schlüssel, 18 KB" in a
 * toast without unzipping the archive.
 */
@Auth()
@Controller('reports/datev-buchungsliste')
export class DatevBuchungslisteController {
  private readonly logger = new Logger(DatevBuchungslisteController.name)

  constructor(private readonly svc: DatevBuchungslisteService) {}

  @Get()
  @Require('reports.read')
  async build(
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
    let month: number | undefined
    if (monthParam !== undefined) {
      month = parseInt(monthParam, 10)
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new BadRequestException(
          `Ungültiger Monat: ${monthParam} (1-12)`,
        )
      }
    }
    const t0 = Date.now()
    const result = await this.svc.buildArchive({
      companyId,
      year,
      month,
    })
    const ms = Date.now() - t0
    this.logger.log(
      `Built DATEV Buchungsliste for ${companyId} year=${year}` +
        (month ? ` month=${month}` : '') +
        ` in ${ms}ms: buchungen=${result.stats.buchungenCount}, ` +
        `sachkonten=${result.stats.sachkontenCount}, ` +
        `ustSchluessel=${result.stats.ustSchluesselCount}, ` +
        `size=${result.stats.totalSize}B`,
    )

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Length': String(result.zipBuffer.length),
      'X-Buchungsliste-Stats': JSON.stringify(result.stats),
      'X-Buchungsliste-Generation-Ms': String(ms),
    })
    res.end(result.zipBuffer)
  }
}
