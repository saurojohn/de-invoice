/**
 * CashflowPnlController — Tier 173 split.
 *
 * Owns the 2 forecast-shape endpoints:
 *
 *   GET /api/v1/reports/cashflow — Tier 74 12/24/36-month
 *                                  bank-balance forecast
 *   GET /api/v1/reports/pnl      — Tier 75 monthly + YTD
 *                                  operating result
 *
 * These are paired because they share the "what's
 * the company's financial health" mental model —
 * cashflow is a projection, pnl is a snapshot. Both
 * depend on the same underlying Prisma aggregations
 * (Invoice + Expense + RecurringInvoice), so the
 * split is by UI surface, not by data dependency.
 *
 * Split out of reports.controller.ts (Tier 173).
 * URL paths preserved.
 */
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import { Auth, Require } from '../../auth/roles.decorator';
import { CashFlowService } from './cashflow.service';
import { PnlService } from './pnl.service';

@Auth()
@Controller('reports')
export class CashflowPnlController {
  constructor(
    private readonly cashflow: CashFlowService,
    private readonly pnl: PnlService,
  ) {}

  /**
   * Tier 74: Liquiditätsplanung (Cash Flow Forecast).
   *
   * 12-month rolling forecast of the company's bank
   * balance, starting from the user's current
   * balance. Each month shows incoming (open invoices
   * + projected recurring templates) and outgoing
   * (booked expenses) plus the cumulative balance.
   *
   * The "trocken" warning (`firstDryMonth`) tells
   * the user WHEN, not just IF, the company would
   * go negative — that's the question every CFO /
   * Steuerberater actually asks: "können wir die
   * nächste Rate noch zahlen?"
   *
   * Query params:
   *   - companyId       (required)
   *   - months          (optional, 1-36, default 12)
   *   - startingBalance (optional, default 0)
   *   - fromDate        (optional, ISO date — defaults
   *                      to start of current month)
   *
   * The startingBalance is NOT auto-derived from
   * bank-import because (a) the sync may be stale
   * and (b) many users have multiple accounts they
   * want to net. The UI exposes an input for it.
   */
  @Get('cashflow')
  @Require('reports.read')
  async getCashflow(
    @Query('companyId') companyId: string,
    @Query('months') monthsRaw?: string,
    @Query('startingBalance') startingBalanceRaw?: string,
    @Query('fromDate') fromDateRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const months = monthsRaw ? parseInt(monthsRaw, 10) : 12
    if (!Number.isFinite(months) || months < 1 || months > 36) {
      throw new BadRequestException('months muss zwischen 1 und 36 liegen')
    }
    const startingBalance = startingBalanceRaw
      ? Number(startingBalanceRaw.replace(',', '.'))
      : 0
    if (!Number.isFinite(startingBalance)) {
      throw new BadRequestException('startingBalance ist keine gültige Zahl')
    }
    return this.cashflow.forecast({
      companyId,
      months,
      startingBalance,
      fromDate: fromDateRaw ? new Date(fromDateRaw) : undefined,
    })
  }

  /**
   * Tier 75: P&L (Gewinn- und Verlustrechnung).
   *
   * Monthly + YTD operating result for a given year,
   * plus a prior-year comparison. The shape mirrors
   * the BWA a Berater would deliver to the Mandant
   * (Umsatzerlöse, Materialaufwand, Sonstige,
   * Betriebsergebnis).
   *
   * `year` defaults to the current year. The
   * Material/Sonstige split is derived from
   * expense.category: anything starting with
   * "Material" or "Waren" → Materialaufwand; the
   * rest → Sonstige. A v2 could integrate a proper
   * BWA category map.
   */
  @Get('pnl')
  @Require('reports.read')
  async getPnl(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.pnl.compute(companyId, year)
  }
}
