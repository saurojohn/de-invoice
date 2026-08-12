/**
 * BwaController — Tier 173 split.
 *
 * Owns the 3 BWA-shaped endpoints:
 *
 *   GET /api/v1/reports/bwa           — Tier 86 monthly BWA
 *   GET /api/v1/reports/bwa.pdf       — BWA as PDF
 *   GET /api/v1/reports/bwa-quarterly — Tier 163 Q vs Q-prior-year
 *
 * The BWA structure is the canonical DATEV Berater
 * report (4-digit bucket codes 1000-5999). All three
 * delegate to BwaService — this controller is
 * a thin HTTP layer (validation + service call +
 * PDF response).
 *
 * Split out of reports.controller.ts (Tier 173).
 * URL paths preserved.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { Auth, Require } from '../../auth/roles.decorator';
import { BwaService } from './bwa.service';

@Auth()
@Controller('reports')
export class BwaController {
  constructor(private readonly bwa: BwaService) {}

  /**
   * Tier 86: BWA (Betriebswirtschaftliche
   * Auswertung). The monthly operating
   * report that a Steuerberater sends to
   * the Mandant. Canonical DATEV BWA
   * structure (4-digit bucket codes 1000-
   * 5999) with Monatswert / Vormonat / YTD /
   * Vorjahres-YTD / % change.
   *
   * Defaults: current calendar year, current
   * month. Year/month validation matches the
   * other report endpoints.
   */
  @Get('bwa')
  @Require('reports.read')
  async getBwa(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('month') monthRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const month = monthRaw ? Number(monthRaw) : now.getMonth() + 1
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month muss zwischen 1 und 12 liegen')
    }
    return this.bwa.compute(companyId, year, month)
  }

  @Get('bwa.pdf')
  @Header('Content-Type', 'application/pdf')
  async getBwaPdf(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('month') monthRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const month = monthRaw ? Number(monthRaw) : now.getMonth() + 1
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month muss zwischen 1 und 12 liegen')
    }
    await this.bwa.renderPdf(companyId, year, month, res)
  }

  // ─── Tier 163: Quarterly BWA ────────────────────
  // Berater's most common view: this quarter vs
  // the same quarter last year. Returns the
  // current-quarter BWA (YTD = quarter sum) +
  // the prior-year same-quarter BWA in a single
  // payload so the frontend can render the diff
  // side-by-side. The YTD field of the existing
  // compute(year, endMonth) is the Q-Summe, so
  // no new aggregation needed.
  // ────────────────────────────────────────────────
  @Get('bwa-quarterly')
  @Require('reports.read')
  async getBwaQuarterly(
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
    const q = (quarterRaw || '').toUpperCase()
    if (!['Q1', 'Q2', 'Q3', 'Q4'].includes(q)) {
      throw new BadRequestException('quarter muss Q1, Q2, Q3 oder Q4 sein')
    }
    return this.bwa.computeQuarter(companyId, year, q as 'Q1' | 'Q2' | 'Q3' | 'Q4')
  }
}
