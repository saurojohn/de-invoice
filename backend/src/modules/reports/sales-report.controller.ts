/**
 * SalesReportController — Tier 173 split.
 *
 * Owns the 4 endpoints that produce the Berater's
 * top-level report cards:
 *
 *   GET /api/v1/reports/sales         — total sales + per-customer + per-month
 *   GET /api/v1/reports/vat           — UStVA breakdown (delegates to ReportsService)
 *   GET /api/v1/reports/customers     — per-customer revenue ledger
 *   GET /api/v1/reports/aging        — accounts-receivable aging buckets
 *
 * Split out of the original 2455-line reports.controller.ts
 * (Tier 173 — split for maintainability; the per-endpoint
 * business logic is unchanged from when these were in the
 * monolith). The URL paths are preserved so the frontend
 * tabs (Umsatzbericht / Kundenbericht / etc.) don't need
 * any changes.
 */
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import { Auth, Require } from '../../auth/roles.decorator';
import { AgingService } from './aging.service';
import { ReportsService } from './reports.service';

@Auth()
@Controller('reports')
export class SalesReportController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly agingService: AgingService,
  ) {}

  @Get('sales')
  @Require('reports.read')
  async getSalesReport(
    @Query('companyId') companyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
    const end = endDate ? new Date(endDate) : new Date();

    return this.reportsService.getSalesReport({
      companyId,
      startDate: start,
      endDate: end,
    });
  }

  @Get('vat')
  @Require('ustva.read')
  async getVatReport(
    @Query('companyId') companyId: string,
    @Query('year') year: string,
    @Query('quarter') quarter?: string,
    @Query('month') month?: string,
  ) {
    return this.reportsService.getVatReport({
      companyId,
      year: parseInt(year, 10),
      quarter: quarter ? parseInt(quarter, 10) : undefined,
      month: month ? parseInt(month, 10) : undefined,
    });
  }

  @Get('customers')
  @Require('reports.read')
  async getCustomerReport(
    @Query('companyId') companyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    // Tier 189: same default-year pattern as
    // /sales above — startDate/endDate fall back
    // to the current calendar year. Without the
    // default, missing query params produced
    // `new Date(undefined)` → Invalid Date → 500
    // from the Prisma query below.
    const start = startDate
      ? new Date(startDate)
      : new Date(new Date().getFullYear(), 0, 1)
    const end = endDate ? new Date(endDate) : new Date()
    return this.reportsService.getCustomerReport({
      companyId,
      startDate: start,
      endDate: end,
    })
  }

  /**
   * Accounts-receivable aging report. Buckets each
   * customer's open (unpaid) invoice amount into
   * current / 1-30 / 31-60 / 61-90 / 90+ days overdue.
   *
   * The result includes:
   *   - per-customer rows (sorted by totalOpen desc)
   *   - per-bucket totals across the whole company
   *   - grandTotal (sum of all buckets)
   *   - asOf (ISO timestamp of when the report was generated)
   */
  @Get('aging')
  @Require('reports.read')
  async getAgingReport(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.agingService.generate(companyId);
  }
}
