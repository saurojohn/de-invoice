import { NOT_AFA_BOOKING } from '../accounting/booked-afa'
/**
 * DashboardController — Tier 173 split.
 *
 * Owns the two dashboard-shaped endpoints:
 *
 *   GET /api/v1/reports/dashboard       — KPI cards + 12-month byMonth
 *   GET /api/v1/reports/dashboard-v2    — adds topCustomers + arAging +
 *                                         recentActivity + costCenterBreakdown
 *
 * The KPIs are Prisma aggregate-driven (single
 * roundtrip per period — see Tier 12 perf
 * notes in the original implementation). 24
 * monthly queries now run in parallel via
 * Promise.all (was a serial for-loop in
 * pre-Tier-12 versions).
 *
 * The v2 endpoint reuses getDashboardKpis via a
 * private `this.` call instead of an HTTP
 * self-fetch — same payload, no auth loop, no
 * HTTP latency. This is the same pattern the
 * BWA quarterly tier uses to chain compute() and
 * prior-year's compute() back to back.
 *
 * Split out of reports.controller.ts (Tier 173).
 * The URL paths are preserved so the frontend
 * /dashboard page doesn't change.
 */
import { businessToday, dayEnd, dayStart } from '../../common/business-date';
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';

import { Auth, Require } from '../../auth/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AgingService } from './aging.service';
import { ISSUED_STATUSES, SALES_TYPES, CLAIM_TYPES } from '../invoice/document-scope'

@Auth()
@Controller('reports')
export class DashboardController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agingService: AgingService,
  ) {}

  @Get('dashboard')
  @Require('reports.read')
  async getDashboardKpis(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    // Tier 478: calendar days of the business, as the date-only fields are
    // stored (midnight UTC, business-date.ts). The upper bound was `now` (new Date()): on
    // a German server an invoice dated today is 02:00 local, so after
    // midnight "this month" and YTD left out today's invoices (spec 213 at
    // 00:11 on 30.09.: 0 € this month).
    const { y, m, d } = businessToday()
    const todayEnd = dayEnd(y, m, d)
    const yearStart = dayStart(y, 0, 1);
    // Last calendar month: previous month's full range.
    const thisMonthStart = dayStart(y, m, 1);
    const lastMonthStart = dayStart(y, m - 1, 1);
    const lastMonthEnd = dayEnd(y, m, 0);
    // 12 months for the trend chart, oldest first.
    const months = Array.from({ length: 12 }, (_, idx) => {
      const i = 11 - idx
      const mStart = dayStart(y, m - i, 1)
      const mEnd = dayEnd(y, m - i + 1, 0)
      return {
        key: `${mStart.getUTCFullYear()}-${String(mStart.getUTCMonth() + 1).padStart(2, '0')}`,
        mStart,
        mEnd,
      }
    })
    // Tier 468: the rows of the whole span read once, the sums taken here.
    // This ran 6 aggregates for YTD / this / last month and 12 × 3 for the
    // chart in parallel — ~45 queries at once in dashboard-v2, next to the
    // aging report: the shape of the P&L's "Can't reach database server"
    // 500 (Tier 466) and of the dashboard-v2 500 seen in Tiers 429 / 463.
    // Same definitions as the aggregates:
    //   invoices — issued sales documents (Tier 424), total / totalVat
    //   expenses — no AfA rows (Tier 437), net / VAT / gross;
    //              open payables = gross of status 'booked'
    const spanStart = months[0].mStart < yearStart ? months[0].mStart : yearStart
    const [invRows, expRows] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          issueDate: { gte: spanStart, lte: todayEnd },
          status: { in: ISSUED_STATUSES },
          type: { in: SALES_TYPES },
        },
        select: { issueDate: true, total: true, totalVat: true },
      }),
      this.prisma.expense.findMany({
        where: { companyId, invoiceDate: { gte: spanStart, lte: todayEnd }, ...NOT_AFA_BOOKING },
        select: { invoiceDate: true, netAmount: true, vatAmount: true, grossAmount: true, status: true },
      }),
    ])
    const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100)
    const aggregateInvoices = (start: Date, end: Date) => {
      let total = 0, vat = 0, count = 0
      for (const r of invRows) {
        if (r.issueDate < start || r.issueDate > end) continue
        total += cents(r.total); vat += cents(r.totalVat); count++
      }
      return { revenue: total / 100, ust: vat / 100, count }
    }
    const aggregateExpenses = (start: Date, end: Date) => {
      let net = 0, vat = 0, open = 0, count = 0
      for (const r of expRows) {
        if (r.invoiceDate < start || r.invoiceDate > end) continue
        net += cents(r.netAmount); vat += cents(r.vatAmount); count++
        if (r.status === 'booked') open += cents(r.grossAmount)
      }
      return { expenses: net / 100, vorsteuer: vat / 100, count, openPayables: open / 100 }
    }
    // Open receivables: single aggregate over
    // all sent/overdue invoices (no date
    // range — they accumulate until paid).
    // Tier 426: less the payments received — this summed the invoice totals,
    // so a part-paid invoice was shown as fully open.
    const openRecvInvoices = await this.prisma.invoice.findMany({
      where: { companyId, status: { in: ['sent', 'overdue'] }, type: { in: CLAIM_TYPES } },
      select: { total: true, payments: { select: { amount: true } } },
    })
    const openReceivables = openRecvInvoices.reduce((s, inv) => {
      const paid = inv.payments.reduce((p, x) => p + Number(x.amount ?? 0), 0)
      const open = Number(inv.total) - paid
      return open > 0 ? s + open : s
    }, 0)
    const ytdInv = aggregateInvoices(yearStart, todayEnd)
    const ytdExp = aggregateExpenses(yearStart, todayEnd)
    const lastInv = aggregateInvoices(lastMonthStart, lastMonthEnd)
    const lastExp = aggregateExpenses(lastMonthStart, lastMonthEnd)
    const thisInv = aggregateInvoices(thisMonthStart, todayEnd)
    const thisExp = aggregateExpenses(thisMonthStart, todayEnd)
    const byMonthMap = new Map<string, { revenue: number; expenses: number }>()
    for (const m of months) {
      byMonthMap.set(m.key, {
        revenue: aggregateInvoices(m.mStart, m.mEnd).revenue,
        expenses: aggregateExpenses(m.mStart, m.mEnd).expenses,
      })
    }
    const byMonth = months.map((m) => ({
      month: m.key,
      ...(byMonthMap.get(m.key) || { revenue: 0, expenses: 0 }),
    }));
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
        // Tier 591: net revenue less net expenses. It was `revenue − expenses`
        // — the invoices' gross totals less the expenses' net amounts, a
        // "profit" too high by the output VAT of the year.
        net: Math.round((ytdInv.revenue - ytdInv.ust - ytdExp.expenses) * 100) / 100,
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
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Tier 36 — consolidated "dashboard v2" endpoint.
   *
   * Wraps the legacy /reports/dashboard (KPIs + byMonth)
   * with three extra slices for the chart-heavy v2 UI:
   *
   *   - topCustomers: top 5 customers by YTD revenue,
   *     so the front-end can render a "Top-Kunden" bar
   *     without N round-trips.
   *
   *   - arAging: the precomputed A/R aging buckets
   *     (`/reports/aging` returns per-customer rows;
   *     we surface only the per-bucket totals here so
   *     the donut chart has ready-made values).
   *
   *   - recentActivity: last 5 invoices (id, number,
   *     total, customerName, dueDate, status) so the
   *     "letzte Aktivität" widget can render.
   *
   * Single round-trip for the entire dashboard; lets the
   * v2 UI render in parallel without waterfall requests.
   *
   * Returns 200 with the same `kpis` shape as the legacy
   * endpoint so a future revert to v1 is one line.
   */
  @Get('dashboard-v2')
  @Require('reports.read')
  async getDashboardV2(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const yearStart = new Date(now.getFullYear(), 0, 1)

    // Run the four expensive queries in parallel.
    // Each is bounded by the underlying SQL — no N+1.
    const [kpis, aging, topCustomers, recent, invByCc, expByCc] =
      await Promise.all([
        // Reuse the legacy aggregator via a private call
        // (avoid HTTP self-fetch latency + auth loops).
        this.getDashboardKpis(companyId),
        this.agingService.generate(companyId),
        // Top 5 customers by YTD revenue. Single SQL —
        // GROUP BY customer, ORDER BY sum DESC, LIMIT 5.
        this.prisma.invoice.groupBy({
          by: ['customerId'],
          where: { companyId, issueDate: { gte: yearStart }, status: { in: ISSUED_STATUSES }, type: { in: SALES_TYPES } },
          _sum: { total: true },
          _count: { _all: true },
          orderBy: { _sum: { total: 'desc' } },
          take: 5,
        }),
        // Last 5 invoices. Sorted by createdAt desc —
        // matches the activity feed ordering.
        this.prisma.invoice.findMany({
          where: { companyId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            customer: { select: { name: true, customerNumber: true } },
          },
        }),
        // Tier 38: cost-center breakdown on invoices YTD.
        // Group by costCenter (a string column); null buckets
        // become "Nicht zugewiesen" in the pie chart legend.
        // We sum total + totalVat separately so the breakdown
        // matches what gets exported to DATEV columns 12/13.
        this.prisma.invoice.groupBy({
          by: ['costCenter'],
          where: {
            companyId,
            issueDate: { gte: yearStart },
            status: { in: ISSUED_STATUSES },
            type: { in: SALES_TYPES },
          },
          _sum: { total: true, totalVat: true },
          _count: { _all: true },
        }),
        // Same idea on the Expense side (Eingangsrechnungen).
        // We only count "booked" expenses — drafts and blocked
        // entries shouldn't skew the dashboard pie.
        this.prisma.expense.groupBy({
          by: ['costCenter'],
          where: {
            companyId,
            invoiceDate: { gte: yearStart },
            status: { in: ['booked', 'deductible'] },
            ...NOT_AFA_BOOKING, // Tier 437
          },
          _sum: { grossAmount: true, vatAmount: true },
          _count: { _all: true },
        }),
      ])

    // Resolve customerId → name/number for topCustomers.
    // Two roundtrips total (groupBy + this one). Most
    // companies have < 50 customers so a single
    // findMany is fine.
    const customerIds = topCustomers.map((r) => r.customerId)
    const customers = customerIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, name: true, customerNumber: true },
        })
      : []
    const nameById = new Map(customers.map((c) => [c.id, c]))

    // Bucket totals from the A/R aging report.
    // AgingReport.totals: { current, days1to30, days31to60, days61to90, days91plus }
    const arAging = aging.totals

    return {
      kpis,
      arAging,
      topCustomers: topCustomers.map((r) => ({
        customerId: r.customerId,
        name: nameById.get(r.customerId)?.name || 'Unbekannt',
        customerNumber: nameById.get(r.customerId)?.customerNumber ?? null,
        revenue: Number(r._sum.total || 0),
        invoiceCount: r._count._all,
      })),
      recentActivity: recent.map((r) => ({
        invoiceId: r.id,
        invoiceNumber: r.invoiceNumber,
        total: Number(r.total),
        currency: r.currency,
        customerName: r.customer?.name || '',
        customerNumber: r.customer?.customerNumber ?? null,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        status: r.status,
      })),
      // Tier 38: cost-center breakdown. Two parallel
      // groupBy results (invoices + expenses) merged into
      // a single sorted list, by total gross amounts
      // descending. Each entry has:
      //   - costCenter: the user-stamped string from
      //     Invoice.costCenter / Expense.costCenter
      //     (null → "Nicht zugewiesen")
      //   - revenue: SUM(invoice.total) YTD
      //   - expense: SUM(expense.grossAmount) YTD
      //   - ust: SUM(invoice.totalVat) YTD (output tax)
      //   - vorsteuer: SUM(expense.vatAmount) YTD (input tax)
      //   - invoiceCount / expenseCount
      //
      // Frontend renders this as a donut chart with the
      // legend showing each cost-center slice's
      //     Netto = revenue - expense
      // plus a § 14/13b USt summary row.
      costCenterBreakdown: mergeCostCenterBreakdown(invByCc, expByCc),
      generatedAt: now.toISOString(),
    }
  }
}

/**
 * Merge the two parallel cost-center groupBy results
 * (invoices + expenses) into a single sorted list. The
 * pie chart's "Nicht zugewiesen" bucket comes from
 * null costCenter rows — we label them on display so
 * the legend always reads as German without an empty
 * "—" slot.
 *
 * Pure function so it's trivial to unit-test if we ever
 * add Jest/Vitest; the e2e covers the integration.
 */
function mergeCostCenterBreakdown(
  invRows: Array<{
    costCenter: string | null
    _sum: { total: any; totalVat: any } | null
    _count: { _all: number }
  }>,
  expRows: Array<{
    costCenter: string | null
    _sum: { grossAmount: any; vatAmount: any } | null
    _count: { _all: number }
  }>,
) {
  const map = new Map<
    string,
    {
      costCenter: string
      revenue: number
      expense: number
      ust: number
      vorsteuer: number
      invoiceCount: number
      expenseCount: number
    }
  >()
  const labelFor = (cc: string | null) =>
    cc && cc.trim() ? cc.trim() : 'Nicht zugewiesen'

  for (const r of invRows) {
    const key = labelFor(r.costCenter)
    const cur = map.get(key) || {
      costCenter: key,
      revenue: 0,
      expense: 0,
      ust: 0,
      vorsteuer: 0,
      invoiceCount: 0,
      expenseCount: 0,
    }
    cur.revenue += Number(r._sum?.total ?? 0)
    cur.ust += Number(r._sum?.totalVat ?? 0)
    cur.invoiceCount += r._count._all
    map.set(key, cur)
  }
  for (const r of expRows) {
    const key = labelFor(r.costCenter)
    const cur = map.get(key) || {
      costCenter: key,
      revenue: 0,
      expense: 0,
      ust: 0,
      vorsteuer: 0,
      invoiceCount: 0,
      expenseCount: 0,
    }
    cur.expense += Number(r._sum?.grossAmount ?? 0)
    cur.vorsteuer += Number(r._sum?.vatAmount ?? 0)
    cur.expenseCount += r._count._all
    map.set(key, cur)
  }
  const list = Array.from(map.values())
  // Sort by net (revenue - expense) absolute amount
  // desc so the biggest cost center is on top of the
  // legend. Within ties, alphabetical.
  list.sort((a, b) => {
    const aNet = Math.abs(a.revenue - a.expense)
    const bNet = Math.abs(b.revenue - b.expense)
    if (bNet !== aNet) return bNet - aNet
    return a.costCenter.localeCompare(b.costCenter)
  })
  return list
}
