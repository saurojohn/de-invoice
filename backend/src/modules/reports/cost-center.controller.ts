/**
 * CostCenterController — Tier 173 split.
 *
 * Owns the 7 cost-center-shaped endpoints:
 *
 *   GET    /api/v1/reports/cost-center-yearly        — Tier 44 per-cc + monthly
 *   GET    /api/v1/reports/cost-center-monthly       — Tier 45 single-month
 *   GET    /api/v1/reports/cost-center-transactions  — Tier 46 invoice+expense union
 *   GET    /api/v1/reports/cost-center-budgets       — Tier 48 list
 *   POST   /api/v1/reports/cost-center-budgets       — Tier 48 upsert
 *   DELETE /api/v1/reports/cost-center-budgets/:id  — Tier 48 delete
 *   GET    /api/v1/reports/cost-center-budget-vs-actual — Tier 48 budget join
 *
 * The cost-center data is large (a single company-year
 * can have ~50 buckets × 12 months × 100s of invoices)
 * and shared across multiple read paths (yearly,
 * monthly, budget-vs-actual, transactions). Rather
 * than refactor the queries into a shared helper, the
 * three top-level read endpoints each do their own
 * Prisma fetch — the SQL is bounded by indexed lookups
 * and the JS folding is O(N) where N is the per-cc
 * monthly count. A shared "cost-center-aggregator"
 * service is a future refactor; for now the per-
 * controller duplication keeps the per-endpoint
 * behaviour easy to reason about.
 *
 * Split out of reports.controller.ts (Tier 173).
 * URL paths preserved.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { Auth, Require } from '../../auth/roles.decorator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Auth()
@Controller('reports')
export class CostCenterController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tier 44: Cost-Center Jahresauswertung.
   *
   * Returns one row per cost-center with:
   *   - revenue / expense / net  (full year)
   *   - ust    / vorsteuer       (full year)
   *   - invoiceCount / expenseCount
   *   - monthly[1..12]           (net amount = revenue − expense per month)
   *
   * Covers the same set of source rows as the dashboard-v2
   * pie (Invoice INV/RCV + Expense booked/deductible) but
   * adds per-month granularity so the front-end can render
   * a 12-cell heat-map / bar-grid per cost-center.
   *
   * `year` defaults to the current year. `costCenter`
   * (optional) filters to a single stamp (the dashboard
   * drill-down case).
   */
  @Get('cost-center-yearly')
  @Require('reports.read')
  async getCostCenterYearly(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year + 1, 0, 1)

    // Two parallel groupBys — Invoice + Expense — filtered
    // to the full year. Same column selection as
    // dashboard-v2 but no YTD shortcut (we need monthly
    // resolution in the JS step).
    const [invRows, expRows] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['costCenter'],
        where: {
          companyId,
          issueDate: { gte: yearStart, lt: yearEnd },
          type: { in: ['INV', 'RCV'] },
        },
        _sum: { total: true, totalVat: true },
        _count: { _all: true },
      }),
      this.prisma.expense.groupBy({
        by: ['costCenter'],
        where: {
          companyId,
          invoiceDate: { gte: yearStart, lt: yearEnd },
          status: { in: ['booked', 'deductible'] },
        },
        _sum: { grossAmount: true, vatAmount: true },
        _count: { _all: true },
      }),
    ])

    // Per-line monthly distribution — we need to walk
    // individual Invoice.total / Expense.grossAmount so
    // we can bucket by issueDate / invoiceDate. groupBy
    // can't pre-bucket by month.
    //
    // The invoiceDate index covers the WHERE; the row
    // count for a single company-year is bounded (a few
    // thousand at worst), so a flat findMany + JS fold
    // beats a 12-query roundtrip. We only project the
    // columns we actually use to keep the wire payload
    // lean.
    const [invMonth, expMonth] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          issueDate: { gte: yearStart, lt: yearEnd },
          type: { in: ['INV', 'RCV'] },
        },
        select: {
          costCenter: true,
          total: true,
          issueDate: true,
        },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          invoiceDate: { gte: yearStart, lt: yearEnd },
          status: { in: ['booked', 'deductible'] },
        },
        select: {
          costCenter: true,
          grossAmount: true,
          invoiceDate: true,
        },
      }),
    ])

    const labelFor = (cc: string | null) =>
      cc && cc.trim() ? cc.trim() : 'Nicht zugewiesen'

    // Same merge shape as dashboard-v2's
    // mergeCostCenterBreakdown — we extend it with
    // monthly buckets.
    type Row = {
      costCenter: string
      revenue: number
      expense: number
      net: number
      ust: number
      vorsteuer: number
      invoiceCount: number
      expenseCount: number
      monthly: number[] // length 12, idx 0 = Jan, …, 11 = Dec
    }
    const map = new Map<string, Row>()
    const getRow = (key: string): Row => {
      let r = map.get(key)
      if (!r) {
        r = {
          costCenter: key,
          revenue: 0,
          expense: 0,
          net: 0,
          ust: 0,
          vorsteuer: 0,
          invoiceCount: 0,
          expenseCount: 0,
          monthly: Array(12).fill(0),
        }
        map.set(key, r)
      }
      return r
    }

    for (const r of invRows) {
      const row = getRow(labelFor(r.costCenter))
      row.revenue += Number(r._sum?.total ?? 0)
      row.ust += Number(r._sum?.totalVat ?? 0)
      row.invoiceCount += r._count._all
    }
    for (const r of expRows) {
      const row = getRow(labelFor(r.costCenter))
      row.expense += Number(r._sum?.grossAmount ?? 0)
      row.vorsteuer += Number(r._sum?.vatAmount ?? 0)
      row.expenseCount += r._count._all
    }
    // Monthly: walk the per-line rows, bucket net by
    // (costCenter, month-0-index).
    for (const inv of invMonth) {
      const d = inv.issueDate
      if (!d) continue
      const m = d.getMonth()
      if (m < 0 || m > 11) continue
      const row = getRow(labelFor(inv.costCenter))
      // Tier 245: Decimal累加 — preserve 4-decimal precision
      // on per-month cost-center totals.
      row.monthly[m] = new Prisma.Decimal(row.monthly[m])
        .plus(new Prisma.Decimal(inv.total ?? 0))
        .toNumber()
    }
    for (const exp of expMonth) {
      const d = exp.invoiceDate
      if (!d) continue
      const m = d.getMonth()
      if (m < 0 || m > 11) continue
      const row = getRow(labelFor(exp.costCenter))
      // Tier 245: Decimal累加 (subtraction)
      row.monthly[m] = new Prisma.Decimal(row.monthly[m])
        .minus(new Prisma.Decimal(exp.grossAmount ?? 0))
        .toNumber()
    }

    // Compute net + sort. Net = revenue − expense. We
    // sort by |net| desc so the biggest cost center
    // (positive or negative) leads — same UX as the
    // dashboard pie. Ties broken alphabetically.
    const rows = Array.from(map.values()).map((r) => ({
      ...r,
      net: r.revenue - r.expense,
      monthly: r.monthly.map((v) => Number(v.toFixed(2))),
      revenue: Number(r.revenue.toFixed(2)),
      expense: Number(r.expense.toFixed(2)),
      ust: Number(r.ust.toFixed(2)),
      vorsteuer: Number(r.vorsteuer.toFixed(2)),
    }))
    rows.sort((a, b) => {
      const da = Math.abs(b.net) - Math.abs(a.net)
      if (da !== 0) return da
      return a.costCenter.localeCompare(b.costCenter)
    })

    // Totals — the "Summe" row at the bottom of the
    // table. Same shape as a single cost-center row but
    // with monthly aggregated across all rows.
    const monthlyTotal = Array(12).fill(0)
    for (const r of rows) {
      for (let i = 0; i < 12; i++) monthlyTotal[i] += r.monthly[i]
    }
    const totals = {
      costCenter: '__TOTAL__',
      revenue: Number(rows.reduce((s, r) => s + r.revenue, 0).toFixed(2)),
      expense: Number(rows.reduce((s, r) => s + r.expense, 0).toFixed(2)),
      net: Number(
        rows.reduce((s, r) => s + r.net, 0).toFixed(2),
      ),
      ust: Number(rows.reduce((s, r) => s + r.ust, 0).toFixed(2)),
      vorsteuer: Number(
        rows.reduce((s, r) => s + r.vorsteuer, 0).toFixed(2),
      ),
      invoiceCount: rows.reduce((s, r) => s + r.invoiceCount, 0),
      expenseCount: rows.reduce((s, r) => s + r.expenseCount, 0),
      monthly: monthlyTotal.map((v) => Number(v.toFixed(2))),
    }

    return {
      year,
      rows,
      totals,
      generatedAt: now.toISOString(),
    }
  }

  /**
   * Tier 45: Cost-Center Monthly drill-in.
   *
   * Same aggregation shape as /cost-center-yearly but
   * scoped to a single calendar month. Returns one row
   * per cost-center that had any activity in the
   * month — empty months produce no rows (not a
   * zero-row with all zeros).
   *
   * The UI uses this for the monthly drill-in page
   * (`/dashboard/cost-center-report/[year]/[month]`)
   * and as the API behind clicking a month-cell on the
   * yearly table.
   *
   * `month` is 1-indexed (1 = Jan, 12 = Dec) to match
   * the URL param convention. Defaults to the current
   * month when omitted.
   */
  @Get('cost-center-monthly')
  @Require('reports.read')
  async getCostCenterMonthly(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('month') monthRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    const month = monthRaw
      ? Number(monthRaw)
      : now.getMonth() + 1 // 0-indexed Date.getMonth() → 1-indexed
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      throw new BadRequestException('month muss zwischen 1 und 12 liegen')
    }
    // month-1 = 0-indexed for Date arithmetic.
    const monthStart = new Date(year, month - 1, 1)
    const monthEnd = new Date(year, month, 1)

    // Two parallel queries — full-row findMany on
    // Invoice + Expense bounded to the month. We don't
    // need groupBy because there are no further
    // buckets to compute (the monthly buckets from
    // tier-44 collapse to a single value here).
    const [invRows, expRows] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          issueDate: { gte: monthStart, lt: monthEnd },
          type: { in: ['INV', 'RCV'] },
        },
        select: {
          costCenter: true,
          total: true,
          totalVat: true,
        },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          invoiceDate: { gte: monthStart, lt: monthEnd },
          status: { in: ['booked', 'deductible'] },
        },
        select: {
          costCenter: true,
          grossAmount: true,
          vatAmount: true,
        },
      }),
    ])

    const labelFor = (cc: string | null) =>
      cc && cc.trim() ? cc.trim() : 'Nicht zugewiesen'

    type Row = {
      costCenter: string
      revenue: number
      expense: number
      net: number
      ust: number
      vorsteuer: number
      invoiceCount: number
      expenseCount: number
    }
    const map = new Map<string, Row>()
    const getRow = (key: string): Row => {
      let r = map.get(key)
      if (!r) {
        r = {
          costCenter: key,
          revenue: 0,
          expense: 0,
          net: 0,
          ust: 0,
          vorsteuer: 0,
          invoiceCount: 0,
          expenseCount: 0,
        }
        map.set(key, r)
      }
      return r
    }
    for (const inv of invRows) {
      const r = getRow(labelFor(inv.costCenter))
      // Tier 245: Decimal累加 (revenue / ust sums)
      r.revenue = new Prisma.Decimal(r.revenue)
        .plus(new Prisma.Decimal(inv.total ?? 0))
        .toNumber()
      r.ust = new Prisma.Decimal(r.ust)
        .plus(new Prisma.Decimal(inv.totalVat ?? 0))
        .toNumber()
      r.invoiceCount += 1
    }
    for (const exp of expRows) {
      const r = getRow(labelFor(exp.costCenter))
      // Tier 245: Decimal累加 (expense / vorsteuer sums)
      r.expense = new Prisma.Decimal(r.expense)
        .plus(new Prisma.Decimal(exp.grossAmount ?? 0))
        .toNumber()
      r.vorsteuer = new Prisma.Decimal(r.vorsteuer)
        .plus(new Prisma.Decimal(exp.vatAmount ?? 0))
        .toNumber()
      r.expenseCount += 1
    }

    const rows = Array.from(map.values()).map((r) => ({
      ...r,
      net: r.revenue - r.expense,
      revenue: Number(r.revenue.toFixed(2)),
      expense: Number(r.expense.toFixed(2)),
      ust: Number(r.ust.toFixed(2)),
      vorsteuer: Number(r.vorsteuer.toFixed(2)),
    }))
    rows.sort((a, b) => {
      const da = Math.abs(b.net) - Math.abs(a.net)
      if (da !== 0) return da
      return a.costCenter.localeCompare(b.costCenter)
    })

    const totals: Row = {
      costCenter: '__TOTAL__',
      revenue: Number(rows.reduce((s, r) => s + r.revenue, 0).toFixed(2)),
      expense: Number(rows.reduce((s, r) => s + r.expense, 0).toFixed(2)),
      net: Number(rows.reduce((s, r) => s + r.net, 0).toFixed(2)),
      ust: Number(rows.reduce((s, r) => s + r.ust, 0).toFixed(2)),
      vorsteuer: Number(
        rows.reduce((s, r) => s + r.vorsteuer, 0).toFixed(2),
      ),
      invoiceCount: rows.reduce((s, r) => s + r.invoiceCount, 0),
      expenseCount: rows.reduce((s, r) => s + r.expenseCount, 0),
    }

    return {
      year,
      month,
      rows,
      totals,
      generatedAt: now.toISOString(),
    }
  }

  /**
   * Tier 46: Cost-Center Transactions drill-in.
   *
   * Returns the actual invoices + expenses that
   * contribute to a single (year, month, costCenter)
   * bucket. The page
   * `/dashboard/cost-center-report/[year]/[month]/[costCenter]`
   * uses this to render a chronological list of
   * postings — "where did this month's 504€ net come
   * from?".
   *
   * The costCenter param matches the dashboard-v2
   * bucket convention: null/empty → "Nicht
   * zugewiesen". We URL-encode the bucket label so
   * spaces and umlauts survive the round-trip; the
   * decode happens here.
   *
   * Pagination via take + skip (defaults to 100 rows).
   * No DB-level cursor — a date-sorted offset is fine
   * for a single-month single-cc slice (bounded to a
   * few hundred rows even for big clients).
   */
  @Get('cost-center-transactions')
  @Require('reports.read')
  async getCostCenterTransactions(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('month') monthRaw?: string,
    @Query('costCenter') costCenterRaw?: string,
    @Query('take') takeRaw?: string,
    @Query('skip') skipRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    const month = monthRaw
      ? Number(monthRaw)
      : now.getMonth() + 1
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      throw new BadRequestException('month muss zwischen 1 und 12 liegen')
    }
    // URL-decode the cost-center label. Front-end
    // sends encodeURIComponent(costCenter); on the
    // server, Express decodes the query string by
    // default so the raw value is already unescaped.
    // We also normalise empty/null → 'Nicht
    // zugewiesen' to match the bucket label from
    // dashboard-v2 / tier-44/45.
    const ccDecoded = costCenterRaw ?? ''
    const ccBucket =
      ccDecoded.trim() === '' || ccDecoded === 'Nicht zugewiesen'
        ? null
        : ccDecoded

    const take = Math.min(
      Math.max(Number(takeRaw) || 100, 1),
      500,
    )
    const skip = Math.max(Number(skipRaw) || 0, 0)

    const monthStart = new Date(year, month - 1, 1)
    const monthEnd = new Date(year, month, 1)

    // Two parallel queries — Invoice + Expense. The
    // costCenter filter on the model column matches
    // the same value the bucket query used (the
    // service stamps the string verbatim into the
    // column on create). NULL cc on the column matches
    // when the bucket is "Nicht zugewiesen".
    //
    // Pagination note: we deliberately do NOT pass
    // take/skip to the SQL queries, because that
    // would slice the Invoice and Expense lists
    // independently — the UI gets a mix of 2
    // invoices + 2 expenses under "take=2" even
    // though there are 100 invoices. We fetch the
    // full slice (bounded by single month + single
    // cc — typically <100 rows) and apply take/skip
    // in JS after merging + date-sorting. The total
    // counts still come from the parallel count
    // query so the UI knows "hasMore" correctly.
    const ccFilter = ccBucket === null ? null : ccBucket
    const [invRows, expRows, invTotal, expTotal] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          costCenter: ccFilter, // null matches costCenter IS NULL
          issueDate: { gte: monthStart, lt: monthEnd },
          type: { in: ['INV', 'RCV'] },
        },
        select: {
          id: true,
          invoiceNumber: true,
          issueDate: true,
          dueDate: true,
          total: true,
          totalVat: true,
          currency: true,
          customerName: true,
          status: true,
        },
        orderBy: { issueDate: 'asc' },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          costCenter: ccFilter,
          invoiceDate: { gte: monthStart, lt: monthEnd },
          status: { in: ['booked', 'deductible'] },
        },
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          description: true,
          supplierId: true,
          grossAmount: true,
          vatAmount: true,
          status: true,
        },
        orderBy: { invoiceDate: 'asc' },
      }),
      // Counts for pagination total (so the UI can
      // show "showing 1-50 of N"). Counting in
      // parallel with the findMany keeps the request
      // to one roundtrip + 1 extra count.
      this.prisma.invoice.count({
        where: {
          companyId,
          costCenter: ccFilter,
          issueDate: { gte: monthStart, lt: monthEnd },
          type: { in: ['INV', 'RCV'] },
        },
      }),
      this.prisma.expense.count({
        where: {
          companyId,
          costCenter: ccFilter,
          invoiceDate: { gte: monthStart, lt: monthEnd },
          status: { in: ['booked', 'deductible'] },
        },
      }),
    ])

    // Normalise to a single union shape — the UI
    // renders one chronological table. `kind` is
    // 'invoice' | 'expense' so the row knows which
    // fields to show (number vs description, etc.).
    type Tx = {
      kind: 'invoice' | 'expense'
      id: string
      date: Date
      number: string
      counterparty: string
      amount: number
      vat: number
      currency: string
      status: string
      _supplierId?: string | null
    }
    const tx: Tx[] = [
      ...invRows.map((i) => ({
        kind: 'invoice' as const,
        id: i.id,
        date: i.issueDate,
        number: i.invoiceNumber,
        counterparty: i.customerName || '',
        amount: Number(i.total),
        vat: Number(i.totalVat),
        currency: i.currency,
        status: i.status,
      })),
      ...expRows.map((e) => ({
        kind: 'expense' as const,
        id: e.id,
        date: e.invoiceDate,
        number: e.invoiceNumber || '',
        // Expense has no supplierName column — just a
        // supplierId FK. We resolve the supplier name
        // below via the supplierNames map. Fallback to
        // description if no supplier row is linked.
        counterparty: e.description || '',
        amount: Number(e.grossAmount),
        vat: Number(e.vatAmount),
        currency: 'EUR',
        status: e.status,
        // Internal field for the supplier name
        // resolution step below. Stripped before the
        // response.
        _supplierId: e.supplierId,
      })),
    ]
    // Resolve supplier names in one query (bounded
    // by the page slice — at most `take` distinct
    // supplierIds).
    const supplierIds = Array.from(
      new Set(
        tx
          .filter((t) => t.kind === 'expense' && t._supplierId)
          .map((t) => t._supplierId as string),
      ),
    )
    let supplierNames = new Map<string, string>()
    if (supplierIds.length > 0) {
      const suppliers = await this.prisma.supplier.findMany({
        where: { id: { in: supplierIds } },
        select: { id: true, name: true },
      })
      supplierNames = new Map(suppliers.map((s) => [s.id, s.name]))
    }
    // Apply the resolved name, falling back to the
    // description we already set if no supplier row
    // exists. Strip the internal _supplierId field
    // before sending.
    for (const t of tx) {
      if (t.kind === 'expense' && t._supplierId) {
        const n = supplierNames.get(t._supplierId)
        if (n) t.counterparty = n
      }
      delete t._supplierId
    }
    tx.sort((a, b) => a.date.getTime() - b.date.getTime())

    // Apply pagination AFTER the merge + sort so
    // "take=2" returns the 2 earliest rows across
    // invoices + expenses combined. Total counts
    // still come from the parallel count() so the
    // UI can show "showing 1-2 of 5".
    const totalCombined = tx.length
    const pagedTx = tx.slice(skip, skip + take)
    const hasMore = skip + take < totalCombined

    const totals = {
      revenue: tx
        .filter((t) => t.kind === 'invoice')
        .reduce((s, t) => s + t.amount, 0),
      expense: tx
        .filter((t) => t.kind === 'expense')
        .reduce((s, t) => s + t.amount, 0),
      ust: tx
        .filter((t) => t.kind === 'invoice')
        .reduce((s, t) => s + t.vat, 0),
      vorsteuer: tx
        .filter((t) => t.kind === 'expense')
        .reduce((s, t) => s + t.vat, 0),
      invoiceCount: invRows.length,
      expenseCount: expRows.length,
      invoiceTotal: invTotal,
      expenseTotal: expTotal,
    }

    return {
      year,
      month,
      costCenter: ccBucket === null ? 'Nicht zugewiesen' : ccBucket,
      transactions: pagedTx,
      totals,
      pagination: { take, skip, hasMore },
      generatedAt: now.toISOString(),
    }
  }

  /**
   * Tier 48: List budgets for a company/year.
   *
   * Returns every CostCenterBudget row for the given
   * (company, year), sorted by costCenter asc.
   * Missing years return []. The frontend renders
   * this as the editable list of monthly targets.
   */
  @Get('cost-center-budgets')
  @Require('reports.read')
  async listCostCenterBudgets(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId)
      throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const rows = await this.prisma.costCenterBudget.findMany({
      where: { companyId, year },
      orderBy: [{ costCenter: 'asc' }, { label: 'asc' }],
    })
    return {
      year,
      budgets: rows.map((r) => ({
        id: r.id,
        costCenter: r.costCenter ?? 'Nicht zugewiesen',
        label: r.label,
        monthlyTargets: r.monthlyTargets,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    }
  }

  /**
   * Tier 48: Upsert a budget. Same (company, cc, year)
   * triple replaces the existing row (the schema's
   * @@unique supports this). The frontend uses this
   * for both create and edit — simpler than two
   * endpoints and matches the Berater workflow of
   * "set the target for the year, refresh each
   * month".
   *
   * `costCenter` empty/null → "Nicht zugewiesen"
   * bucket. `monthlyTargets` MUST be length 12 with
   * numeric values.
   */
  @Post('cost-center-budgets')
  @Require('reports.write')
  async upsertCostCenterBudget(
    @Query('companyId') companyId: string,
    @Body()
    body: {
      year: number
      costCenter?: string | null
      monthlyTargets: number[]
      label?: string | null
    },
  ) {
    if (!companyId)
      throw new BadRequestException('companyId ist erforderlich')
    if (!body || !Number.isFinite(body.year))
      throw new BadRequestException('year ist erforderlich')
    if (
      !Array.isArray(body.monthlyTargets) ||
      body.monthlyTargets.length !== 12
    ) {
      throw new BadRequestException(
        'monthlyTargets muss ein Array der Länge 12 sein',
      )
    }
    if (
      !body.monthlyTargets.every(
        (v) => typeof v === 'number' && Number.isFinite(v),
      )
    ) {
      throw new BadRequestException(
        'monthlyTargets darf nur Zahlen enthalten',
      )
    }
    // Empty / null costCenter maps to NULL on the
    // column → "Nicht zugewiesen" pseudo-bucket.
    const cc =
      body.costCenter && body.costCenter.trim().length > 0
        ? body.costCenter.trim()
        : null

    // Prisma's generated type for the compound
    // unique input declares costCenter as non-null
    // string even when the column is nullable. We
    // sidestep the typing issue by doing findFirst
    // + create | update manually. The race window is
    // small (one user editing one budget), and we
    // keep the @@unique in the schema so the DB
    // enforces the constraint.
    const existing = await this.prisma.costCenterBudget.findFirst({
      where: { companyId, costCenter: cc, year: body.year },
    })
    const row = existing
      ? await this.prisma.costCenterBudget.update({
          where: { id: existing.id },
          data: {
            monthlyTargets: body.monthlyTargets,
            label: body.label ?? null,
          },
        })
      : await this.prisma.costCenterBudget.create({
          data: {
            companyId,
            costCenter: cc,
            year: body.year,
            monthlyTargets: body.monthlyTargets,
            label: body.label ?? null,
          },
        })

    return {
      id: row.id,
      costCenter: row.costCenter ?? 'Nicht zugewiesen',
      label: row.label,
      monthlyTargets: row.monthlyTargets,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  /**
   * Tier 48: Delete a budget by id. The frontend
   * shows a confirm dialog and only fires this if
   * the user agrees — the data is small enough that
   * we don't soft-delete.
   */
  @Delete('cost-center-budgets/:id')
  @Require('reports.write')
  async deleteCostCenterBudget(@Param('id') id: string) {
    const row = await this.prisma.costCenterBudget.delete({
      where: { id },
    })
    return {
      id: row.id,
      costCenter: row.costCenter ?? 'Nicht zugewiesen',
      year: row.year,
    }
  }

  /**
   * Tier 48: Budget vs Actual report.
   *
   * Joins CostCenterBudget rows with the same
   * per-cc monthly aggregation as the tier-44 yearly
   * endpoint. Returns per-cc rows with:
   *   - target[12]  : the budgeted amount per month
   *   - actual[12]  : net (revenue − expense) per month
   *   - delta[12]   : actual − target (positive = over
   *                   budget for expenses / under
   *                   budget for revenue targets)
   *   - pct[12]     : actual / target as a fraction
   *                   (null when target = 0)
   *
   * Plus a yearly rollup row. Empty budget for a
   * cost-center → target = 0, delta = actual.
   *
   * The UI uses this to render a side-by-side
   * actual/budget table with green/red colouring and
   * a Δ column showing over/under.
   */
  @Get('cost-center-budget-vs-actual')
  @Require('reports.read')
  async getCostCenterBudgetVsActual(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId)
      throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year + 1, 0, 1)

    // Same data fetches as tier-44 — we duplicate
    // rather than refactor into a shared helper
    // because the yearly endpoint already does this
    // work and the controller's class is already
    // large. If a third consumer appears we'll
    // extract.
    // Tier 356: this used to be a Promise.all of three queries, but the
    // invoice and expense groupBy results were never read — two
    // aggregations ran against Postgres on every request and were thrown
    // away. Only the budgets are used here.
    const budgets = await this.prisma.costCenterBudget.findMany({
      where: { companyId, year },
    })

    // Per-line monthly walk — same as tier-44.
    const [invMonth, expMonth] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          issueDate: { gte: yearStart, lt: yearEnd },
          type: { in: ['INV', 'RCV'] },
        },
        select: { costCenter: true, total: true, issueDate: true },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          invoiceDate: { gte: yearStart, lt: yearEnd },
          status: { in: ['booked', 'deductible'] },
        },
        select: {
          costCenter: true,
          grossAmount: true,
          invoiceDate: true,
        },
      }),
    ])

    const labelFor = (cc: string | null) =>
      cc && cc.trim() ? cc.trim() : 'Nicht zugewiesen'

    // Group actuals by bucket (matches tier-44 row
    // shape so we can join).
    type Row = {
      costCenter: string
      costCenterRaw: string | null
      target: number[]
      actual: number[]
      label: string | null
    }
    const map = new Map<string, Row>()
    const getRow = (key: string, raw: string | null): Row => {
      let r = map.get(key)
      if (!r) {
        r = {
          costCenter: key,
          costCenterRaw: raw,
          target: Array(12).fill(0),
          actual: Array(12).fill(0),
          label: null,
        }
        map.set(key, r)
      }
      return r
    }

    // Apply budget targets first.
    for (const b of budgets) {
      const r = getRow(labelFor(b.costCenter), b.costCenter)
      // b.monthlyTargets is stored as a Json value
      // — we trust the controller-side validation on
      // upsert and assert here defensively.
      const arr = Array.isArray(b.monthlyTargets)
        ? (b.monthlyTargets as number[])
        : []
      for (let i = 0; i < 12; i++) {
        r.target[i] = Number(arr[i] ?? 0)
      }
      r.label = b.label
    }

    // Apply actuals (gross net = revenue − expense).
    for (const inv of invMonth) {
      const d = inv.issueDate
      const m = d.getMonth()
      const r = getRow(labelFor(inv.costCenter), inv.costCenter)
      // Tier 245: Decimal累加 (per-month actual)
      r.actual[m] = new Prisma.Decimal(r.actual[m])
        .plus(new Prisma.Decimal(inv.total ?? 0))
        .toNumber()
    }
    for (const exp of expMonth) {
      const d = exp.invoiceDate
      const m = d.getMonth()
      const r = getRow(labelFor(exp.costCenter), exp.costCenter)
      r.actual[m] = new Prisma.Decimal(r.actual[m])
        .minus(new Prisma.Decimal(exp.grossAmount ?? 0))
        .toNumber()
    }

    // Build the response rows with delta + pct.
    // Sort by |yearlyDelta| desc so the biggest
    // over/under bubbles to the top — same UX as
    // tier-44's tier-38 pie.
    const rows = Array.from(map.values()).map((r) => {
      const delta = r.target.map((t, i) =>
        Number((r.actual[i] - t).toFixed(2)),
      )
      const pct = r.target.map((t, i) =>
        t === 0 ? null : Number((r.actual[i] / t).toFixed(4)),
      )
      const targetTotal = Number(
        r.target.reduce((s, v) => s + v, 0).toFixed(2),
      )
      const actualTotal = Number(
        r.actual.reduce((s, v) => s + v, 0).toFixed(2),
      )
      return {
        costCenter: r.costCenter,
        label: r.label,
        target: r.target,
        actual: r.actual,
        delta,
        pct,
        targetTotal,
        actualTotal,
        deltaTotal: Number((actualTotal - targetTotal).toFixed(2)),
      }
    })
    rows.sort((a, b) => {
      const da = Math.abs(b.deltaTotal) - Math.abs(a.deltaTotal)
      if (da !== 0) return da
      return a.costCenter.localeCompare(b.costCenter)
    })

    // Rollup totals.
    const target = Array(12).fill(0)
    const actual = Array(12).fill(0)
    const delta = Array(12).fill(0)
    const pct: (number | null)[] = Array(12).fill(0).map((_, i) => {
      if (target[i] === 0) return null
      return Number((actual[i] / target[i]).toFixed(4))
    })
    for (const r of rows) {
      for (let i = 0; i < 12; i++) {
        target[i] += r.target[i]
        actual[i] += r.actual[i]
        delta[i] += r.delta[i]
      }
    }
    for (let i = 0; i < 12; i++) {
      target[i] = Number(target[i].toFixed(2))
      actual[i] = Number(actual[i].toFixed(2))
      delta[i] = Number(delta[i].toFixed(2))
      pct[i] = target[i] === 0 ? null : Number((actual[i] / target[i]).toFixed(4))
    }
    const targetTotal = Number(target.reduce((s, v) => s + v, 0).toFixed(2))
    const actualTotal = Number(actual.reduce((s, v) => s + v, 0).toFixed(2))
    const deltaTotal = Number(delta.reduce((s, v) => s + v, 0).toFixed(2))

    return {
      year,
      rows,
      totals: {
        target,
        actual,
        delta,
        pct,
        targetTotal,
        actualTotal,
        deltaTotal,
      },
      generatedAt: now.toISOString(),
    }
  }
}
