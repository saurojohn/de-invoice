import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  BadRequestException,
  UseGuards,
  Header,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { Response } from 'express'
import { AnlageSOV2Service } from './anlage-so-v2.service'
import { HeaderAuthGuard } from '../../auth/header-auth.guard'

/**
 * Tier 113 v2: Anlage SO — Broker PDF/CSV auto-import
 * + full loss-verrechnung (§ 23 Abs. 3 Satz 3-5 EStG)
 * + auto-import from bank-transaction Expense rows.
 *
 * Three new endpoints (one extra for the loss-carryforward
 * read):
 *   POST /api/v1/accounting/anlage-so/import-csv
 *   POST /api/v1/accounting/anlage-so/import-from-expenses
 *   GET  /api/v1/accounting/anlage-so/loss-carryforward
 *   GET  /api/v1/accounting/anlage-so/importable-expenses
 *
 * The v2 endpoints sit alongside v1's
 *   GET  /anlage-so, GET /anlage-so.pdf, PUT /anlage-so/settings
 * (those are kept in accounting.controller.ts for
 * backward compat; the v1 compute() math is unchanged).
 *
 * The v2 compute() lives in AnlageSOV2Service — same
 * shape as v1's response, plus the loss-verrechnung
 * block (inFristGain / inFristLoss / priorYearLoss /
 * totalTaxableGain / carryforward / freigrenzeApplied).
 * The frontend uses the v2 service to read the richer
 * compute() — see the GET below.
 */
@Controller('accounting/anlage-so')
@UseGuards(HeaderAuthGuard)
export class AnlageSOV2Controller {
  constructor(private anlageSoV2: AnlageSOV2Service) {}

  /**
   * GET /api/v1/accounting/anlage-so/v2?companyId=...&year=...
   * The v2 compute() — same shape as v1's
   * /anlage-so response + the loss-verrechnung block.
   * The frontend uses this to show the new Verlustvortrag
   * line in the summary card.
   */
  @Get('v2')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getAnlageSoV2(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.anlageSoV2.compute(companyId, year)
  }

  /**
   * GET /api/v1/accounting/anlage-so/v2.pdf?companyId=...&year=...
   * The v2 PDF — same layout as v1 + the loss-verrechnung
   * summary block + the Kz 99 line.
   */
  @Get('v2.pdf')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Content-Type', 'application/pdf')
  async getAnlageSoV2Pdf(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    await this.anlageSoV2.renderPdf(companyId, year, res)
  }

  /**
   * POST /api/v1/accounting/anlage-so/import-csv
   * Body: {
   *   companyId, year, csv, previewOnly (default true),
   *   replace (default false)
   * }
   * Returns either the preview or the import result
   * (see the service for the response shape).
   */
  @Post('import-csv')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async importCsv(
    @Body()
    body: {
      companyId: string
      year: number
      csv: string
      previewOnly?: boolean
      replace?: boolean
    },
  ) {
    if (!body || !body.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!body.csv || typeof body.csv !== 'string') {
      throw new BadRequestException('csv ist erforderlich (string)')
    }
    if (!Number.isInteger(body.year) || body.year < 2000 || body.year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const previewOnly = body.previewOnly !== false // default true
    const replace = body.replace === true
    return this.anlageSoV2.importCsv(
      body.companyId,
      body.year,
      body.csv,
      previewOnly,
      replace,
    )
  }

  /**
   * POST /api/v1/accounting/anlage-so/import-from-expenses?companyId=...&year=...
   * Body: {} (the year + companyId are in the query)
   * Returns the import result:
   *   { importedCount, skippedCount, transactions }
   */
  @Post('import-from-expenses')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async importFromExpenses(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = Number(yearRaw)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.anlageSoV2.importFromExpenses(companyId, year)
  }

  /**
   * GET /api/v1/accounting/anlage-so/loss-carryforward?companyId=...&year=...
   * Returns the carryforward for the given year + the
   * prior-year carryforward (the one used in the
   * current year's compute()).
   */
  @Get('loss-carryforward')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async getLossCarryforward(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.anlageSoV2.getLossCarryforward(companyId, year)
  }

  /**
   * GET /api/v1/accounting/anlage-so/importable-expenses?companyId=...&year=...
   * Returns the Expense rows eligible for auto-import
   * (category = crypto | brokerage, in the year). Each
   * item carries an `alreadyImported` flag so the UI
   * can pre-check the not-yet-imported ones.
   */
  @Get('importable-expenses')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async listImportableExpenses(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.anlageSoV2.listImportableExpenses(companyId, year)
  }
}
