import { Controller, Get, Query, BadRequestException, Res, Header } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { AgingService } from './aging.service';
import { PrismaService } from '../../prisma/prisma.service';
import { generateDatevBuchungsstapel, buildBuchungenFromDb } from './datev.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly agingService: AgingService,
    private readonly prisma: PrismaService,
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
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportsService.getCustomerReport({
      companyId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    });
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

  /**
   * DATEV Buchungsstapel export — ASCII CSV in DATEV 5.0
   * format. Returns a Windows-1252 (Latin-1) text file
   * the Steuerberater imports into DATEV Rechnungswesen.
   *
   * Default date range: the current calendar year. Pass
   * `startDate` / `endDate` as ISO 8601 to override.
   *
   * The CSV includes one header line + one data line per
   * Buchungssatz. Source data is paid invoices (revenue
   * side) + booked expenses (input tax / cost side). The
   * Berater can remap the default SKR03 accounts in
   * DATEV before finalising the import.
   *
   * Response sets:
   *   - Content-Type: text/csv; charset=windows-1252
   *   - Content-Disposition: attachment; filename="..."
   *   - Body: Latin-1 encoded CSV
   */
  @Get('datev-export')
  @Require('reports.read')
  async datevExport(
    @Query('companyId') companyId: string,
    @Query('startDate') startDateStr: string,
    @Query('endDate') endDateStr: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new BadRequestException('Company not found');

    const startDate = startDateStr
      ? new Date(startDateStr)
      : new Date(new Date().getFullYear(), 0, 1);
    const endDate = endDateStr
      ? new Date(endDateStr)
      : new Date();

    const buchungen = await buildBuchungenFromDb(
      this.prisma,
      companyId,
      startDate,
      endDate,
    );

    const csv = generateDatevBuchungsstapel({
      company: {
        id: company.id,
        name: company.name,
        taxId: company.taxId,
        // Per-company Berater-Nr / Mandanten-Nr. Stored
        // alongside the account map in Company.settings.
        // The Berater hands these to the client; without
        // them we fall back to placeholders that the
        // Berater overwrites on import.
        beraterNr: (company as any).settings?.datev?.beraterNr || '00000',
        mandantenNr: (company as any).settings?.datev?.mandantenNr || '00001',
      },
      startDate,
      endDate,
      buchungen,
    });

    const filename = `DATEV_Buchungsstapel_${startDate.toISOString().split('T')[0]}_${endDate.toISOString().split('T')[0]}.csv`;

    // Hand-rolled response: the @Header() decorator
    // doesn't reliably reach the buffer stream when
    // @Res() is in non-passthrough mode, and passthrough
    // mode swallows the body. The two-line approach
    // (set headers, res.end(buffer)) works in every
    // NestJS version. Content-Type uses Windows-1252
    // because that's what DATEV 5.0 expects.
    res.setHeader('Content-Type', 'text/csv; charset=windows-1252');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(Buffer.from(csv, 'latin1'));
  }

  /**
   * Dashboard KPI snapshot. Single endpoint that
   * powers the home-screen tiles + month-over-month
   * change indicators. The frontend previously did
   * 3+ separate fetches (invoices, sales by month,
   * expenses) and reduced them client-side; that
   * was slow and the math was wrong at the year
   * boundary. This endpoint is the authoritative
   * source: one round-trip, server-side math,
   * month-bucketed for the chart.
   *
   * Returns:
   *   - ytd: { revenue, expenses, vorsteuer, ust,
   *           countInvoices, countExpenses }
   *   - lastMonth: same shape (the calendar month
   *     before today)
   *   - thisMonth: same shape
   *   - changes: { revenue, expenses, ... } %
   *     thisMonth vs lastMonth
   *   - openReceivables: total of sent/overdue
   *     invoices (the cash the company is owed)
   *   - openPayables: total of booked (unpaid)
   *     expenses (the cash the company owes)
   *   - byMonth: [{ month, revenue, expenses }]
   *     for the last 12 months for the chart
   *   - generatedAt: ISO timestamp
   */
  @Get('dashboard')
  @Require('reports.read')
  async getDashboardKpis(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1);
    // Last calendar month: previous month's full range.
    // 1st of current month is the day AFTER last
    // month's last day.
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    // Helper: aggregate one Invoice set.
    const aggregateInvoices = async (start: Date, end: Date) => {
      const rows = await this.prisma.invoice.findMany({
        where: { companyId, issueDate: { gte: start, lte: end } },
        select: { total: true, status: true },
      });
      let revenue = 0;
      let ust = 0;
      let count = 0;
      for (const r of rows) {
        revenue += Number(r.total);
        // USt is recoverable from total via the
        // stored USt portion: for a standard 19%
        // invoice, USt = total * 19/119. The Invoice
        // model only carries total, so we approximate
        // with the 19% extraction. For mixed-rate
        // sales the exact figure is slightly off but
        // the dashboard tile only shows magnitude.
        ust += Number(r.total) * (19 / 119);
        count += 1;
      }
      return { revenue, ust, count };
    };
    // Helper: aggregate one Expense set.
    const aggregateExpenses = async (start: Date, end: Date) => {
      const rows = await this.prisma.expense.findMany({
        where: { companyId, invoiceDate: { gte: start, lte: end } },
        select: { netAmount: true, vatAmount: true, grossAmount: true, status: true },
      });
      let expenses = 0;
      let vorsteuer = 0;
      let count = 0;
      let open = 0;
      for (const r of rows) {
        expenses += Number(r.netAmount);
        vorsteuer += Number(r.vatAmount);
        count += 1;
        if (r.status === 'booked') open += Number(r.grossAmount);
      }
      return { expenses, vorsteuer, count, openPayables: open };
    };
    const [ytdInv, ytdExp, lastInv, lastExp, thisInv, thisExp, openRecvRows] = await Promise.all([
      aggregateInvoices(yearStart, now),
      aggregateExpenses(yearStart, now),
      aggregateInvoices(lastMonthStart, lastMonthEnd),
      aggregateExpenses(lastMonthStart, lastMonthEnd),
      aggregateInvoices(thisMonthStart, now),
      aggregateExpenses(thisMonthStart, now),
      // Open receivables = unpaid sent + overdue invoices
      this.prisma.invoice.findMany({
        where: { companyId, status: { in: ['sent', 'overdue'] } },
        select: { total: true },
      }),
    ]);
    const openReceivables = openRecvRows.reduce(
      (s, r) => s + Number(r.total),
      0,
    );
    // 12-month series for the trend chart. Iterate
    // month-by-month; for each, query the same
    // aggregates. 12 months × 2 queries = 24 queries
    // — within the connection pool limit, and the
    // alternative (one big query) is harder to keep
    // correct with date boundaries.
    const byMonth: Array<{
      month: string
      revenue: number
      expenses: number
    }> = [];
    for (let i = 11; i >= 0; i--) {
      const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const [inv, exp] = await Promise.all([
        aggregateInvoices(mStart, mEnd),
        aggregateExpenses(mStart, mEnd),
      ]);
      byMonth.push({
        month: `${mStart.getFullYear()}-${String(mStart.getMonth() + 1).padStart(2, '0')}`,
        revenue: inv.revenue,
        expenses: exp.expenses,
      });
    }
    // Pct change: thisMonth vs lastMonth. Guard
    // against division by zero.
    const pct = (cur: number, prev: number) => {
      if (prev === 0) return cur === 0 ? 0 : 100;
      return Math.round(((cur - prev) / prev) * 1000) / 10;
    };
    return {
      ytd: {
        revenue: ytdInv.revenue,
        ust: ytdInv.ust,
        countInvoices: ytdInv.count,
        expenses: ytdExp.expenses,
        vorsteuer: ytdExp.vorsteuer,
        countExpenses: ytdExp.count,
        net: ytdInv.revenue - ytdExp.expenses,
      },
      thisMonth: {
        revenue: thisInv.revenue,
        ust: thisInv.ust,
        countInvoices: thisInv.count,
        expenses: thisExp.expenses,
        vorsteuer: thisExp.vorsteuer,
        countExpenses: thisExp.count,
      },
      lastMonth: {
        revenue: lastInv.revenue,
        ust: lastInv.ust,
        countInvoices: lastInv.count,
        expenses: lastExp.expenses,
        vorsteuer: lastExp.vorsteuer,
        countExpenses: lastExp.count,
      },
      changes: {
        revenue: pct(thisInv.revenue, lastInv.revenue),
        expenses: pct(thisExp.expenses, lastExp.expenses),
        ust: pct(thisInv.ust, lastInv.ust),
        vorsteuer: pct(thisExp.vorsteuer, lastExp.vorsteuer),
      },
      openReceivables,
      openPayables: ytdExp.openPayables,
      byMonth,
      generatedAt: now.toISOString(),
    };
  }
}
