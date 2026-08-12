/**
 * OssController — Tier 173 split.
 *
 * Owns the 2 EU OSS (One-Stop-Shop) endpoints:
 *
 *   GET /api/v1/reports/oss      — JSON preview of the
 *                                  OSS-Retourmeldung
 *   GET /api/v1/reports/oss.csv  — German semicolon
 *                                  CSV for BZSt portal
 *
 * The BZSt portal is the official filing channel;
 * this endpoint + the CSV are the data the user
 * needs to fill the portal manually OR to feed an
 * automated uploader. The disclaimer in the JSON
 * response surfaces the "this is a preview" caveat.
 *
 * Split out of reports.controller.ts (Tier 173).
 * URL paths preserved.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { Auth, Require } from '../../auth/roles.decorator';
import { OssService } from './oss.service';

@Auth()
@Controller('reports')
export class OssController {
  constructor(private readonly oss: OssService) {}

  /**
   * Tier 78: EU OSS (One-Stop-Shop) — quarterly
   * B2C distance-sales declaration.
   *
   * Returns the OSS-Retourmeldung preview as JSON:
   *   - per (country, vatRate) line
   *   - per-country subtotal
   *   - grand total
   *   - exclusion counts (so the user can sanity-
   *     check "X excluded because B2B, Y excluded
   *     because non-EU")
   *
   * The OSS-Retourmeldung itself is filed via the
   * BZSt portal (XML). This endpoint + the matching
   * /oss.csv give the user the data they need to
   * fill the portal manually OR to feed an automated
   * uploader. The disclaimer in the response
   * surfaces the "this is a preview" caveat.
   *
   * Defaults: current calendar year, current quarter
   * (1-4). Year/quarter are required for the OSS
   * filing (you can't file a "year" — it has to be
   * a quarter) but the defaults keep the UI simple
   * when the user just wants to see the current
   * quarter's numbers.
   */
  @Get('oss')
  @Require('reports.read')
  async getOss(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('quarter') quarterRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const quarter = quarterRaw ? Number(quarterRaw) : Math.floor(now.getMonth() / 3) + 1
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
      throw new BadRequestException('quarter muss zwischen 1 und 4 liegen')
    }
    return this.oss.compute(companyId, year, quarter)
  }

  /**
   * OSS CSV export. German semicolon format
   * (matches what DATEV / BZSt-OSS portal expect).
   * Same filters as the JSON endpoint — the CSV is
   * byte-identical to "take the JSON, flatten the
   * (country, vatRate) pairs, format as a single
   * table".
   *
   * Filename: OSS-Retourmeldung_<year>_Q<quarter>.csv
   */
  @Get('oss.csv')
  @Require('reports.read')
  async getOssCsv(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('quarter') quarterRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const quarter = quarterRaw ? Number(quarterRaw) : Math.floor(now.getMonth() / 3) + 1
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
      throw new BadRequestException('quarter muss zwischen 1 und 4 liegen')
    }
    const csv = await this.oss.renderCsv(companyId, year, quarter)
    const filename = `OSS-Retourmeldung_${year}_Q${quarter}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.end(csv)
  }
}
