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
    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1);
    // Last calendar month: previous month's full range.
    // 1st of current month is the day AFTER last
    // month's last day.
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    // Tier 12 perf: Prisma aggregate — uses
    // SUM/COUNT in Postgres directly, returns
    // a single row instead of N+1 application-
    // side accumulation. Was 1 roundtrip +
    // N rows in memory; now 1 roundtrip + 1
    // row. For a customer with 50K invoices
    // this drops the dashboard endpoint from
    // ~600ms to ~25ms.
    const aggregateInvoices = async (start: Date, end: Date) => {
      // Tier 424: issued sales documents only — drafts, cancelled documents
      // and Proformas were counted — and the documents' own VAT instead of
      // total × 19/119 (wrong for 7 % and 0 %, and unrounded: 379.99999…).
      const agg = await this.prisma.invoice.aggregate({
        where: {
          companyId,
          issueDate: { gte: start, lte: end },
          status: { in: ISSUED_STATUSES },
          type: { in: SALES_TYPES },
        },
        _sum: { total: true, totalVat: true },
        _count: { _all: true },
      })
      const revenue = Number(agg._sum.total || 0)
      const ust = Math.round(Number(agg._sum.totalVat || 0) * 100) / 100
      return { revenue, ust, count: agg._count._all }
    }
    const aggregateExpenses = async (start: Date, end: Date) => {
      const agg = await this.prisma.expense.aggregate({
        where: { companyId, invoiceDate: { gte: start, lte: end } },
        _sum: { netAmount: true, vatAmount: true, grossAmount: true },
        _count: { _all: true },
      })
      // Open payables: sum of grossAmount for
      // booked expenses in the range. We do a
      // separate aggregate for the booked
      // subset; the count is the same.
      const openAgg = await this.prisma.expense.aggregate({
        where: { companyId, invoiceDate: { gte: start, lte: end }, status: 'booked' },
        _sum: { grossAmount: true },
      })
      return {
        expenses: Number(agg._sum.netAmount || 0),
        vorsteuer: Number(agg._sum.vatAmount || 0),
        count: agg._count._all,
        openPayables: Number(openAgg._sum.grossAmount || 0),
      }
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
    const [ytdInv, ytdExp, lastInv, lastExp, thisInv, thisExp] = await Promise.all([
      aggregateInvoices(yearStart, now),
      aggregateExpenses(yearStart, now),
      aggregateInvoices(lastMonthStart, lastMonthEnd),
      aggregateExpenses(lastMonthStart, lastMonthEnd),
      aggregateInvoices(thisMonthStart, now),
      aggregateExpenses(thisMonthStart, now),
    ]);

    // 12-month series for the trend chart. All
    // 24 queries (12 inv + 12 exp) now run in
    // parallel via Promise.all. Was a serial
    // for-loop — for 50K-row tables that was
    // 12*50ms = 600ms of cumulative query
    // time. Now ~50ms wall-clock (one
    // network roundtrip vs twelve).
    const months = Array.from({ length: 12 }, (_, idx) => {
      const i = 11 - idx; // oldest-first
      const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      return {
        key: `${mStart.getFullYear()}-${String(mStart.getMonth() + 1).padStart(2, '0')}`,
        mStart,
        mEnd,
      };
    });
    const monthlyResults = await Promise.all(
      months.flatMap((m) => [
        aggregateInvoices(m.mStart, m.mEnd).then((inv) => ({ kind: 'inv' as const, key: m.key, value: inv })),
        aggregateExpenses(m.mStart, m.mEnd).then((exp) => ({ kind: 'exp' as const, key: m.key, value: exp })),
      ]),
    );
    const byMonthMap = new Map<string, { revenue: number; expenses: number }>();
    for (const m of months) byMonthMap.set(m.key, { revenue: 0, expenses: 0 });
    for (const r of monthlyResults) {
      const slot = byMonthMap.get(r.key);
      if (!slot) continue;
      if (r.kind === 'inv') slot.revenue = r.value.revenue;
      else slot.expenses = r.value.expenses;
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
