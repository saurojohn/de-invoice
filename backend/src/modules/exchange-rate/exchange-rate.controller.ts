/**
 * ExchangeRateController — read / manually refresh
 * the ECB rate snapshot for the current company.
 *
 * The cron in ExchangeRateService runs daily at
 * 02:00 Berlin; this controller is the manual
 * override (the user clicks "Jetzt aktualisieren"
 * in the DATEV settings card).
 *
 * The snapshot lives in
 * `Company.settings.datev.exchangeRates` —
 * returned in the same shape as the datev-config
 * endpoint so the frontend can render a single
 * table with all DATEV-related state.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  BadRequestException,
} from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { ExchangeRateService } from './exchange-rate.service'

@Auth()
@Controller('exchange-rates')
export class ExchangeRateController {
  constructor(private readonly rates: ExchangeRateService) {}

  /**
   * Get the cached rate snapshot for the current
   * company. Null if the cron hasn't run yet (or
   * the manual refresh hasn't been hit) — the
   * frontend uses null to render the
   * "noch keine Kurse geladen" hint.
   */
  @Get()
  @Require('reports.read')
  async get(
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    return this.rates.getRatesForCompany(companyId)
  }

  /**
   * Manual refresh. Fetches the latest ECB rates
   * right now and persists them. The frontend
   * shows a "Wird aktualisiert…" spinner while
   * the request is in flight (typical latency
   * 500-1500ms).
   */
  @Post('refresh')
  @Require('company.update')
  async refresh(
    @Body() body: { companyId: string },
  ) {
    if (!body?.companyId) {
      throw new BadRequestException('companyId is required')
    }
    const snapshot = await this.rates.fetchEcbRates()
    await this.rates.saveRatesForCompany(body.companyId, snapshot)
    return snapshot
  }
}
