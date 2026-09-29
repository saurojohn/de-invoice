import { assetDisposals } from '../assets/disposals'
import { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ISSUED_STATUSES, SALES_TYPES } from '../invoice/document-scope'
import { cashBookings } from '../cashbook/cash-bookings'
import { invoiceNetRevenue } from '../invoice/tax-breakdown'

/**
 * Tier 75: P&L (Gewinn- und Verlustrechnung).
 *
 * The user-facing counterpart to the Steuerberater's
 * monthly BWA. Computes the operating result for a
 * given year, broken down by month, with the same
 * accounting shape a Berater would deliver to the
 * Mandant.
 *
 *   Umsatzerlöse (revenue)
 *   - Materialaufwand (waren/material)
 *   - Sonstige betriebliche Aufwendungen
 *   = Betriebsergebnis
 *
 * Inputs:
 *   - Revenue: Invoice.netTotal (net of VAT) for
 *     status in [paid, sent, overdue, draft]. We
 *     use NET (without VAT) because the Betriebsergebnis
 *     calculation must exclude USt — VAT is a
 *     pass-through (Kz 1776 Verbindlichkeit).
 *   - Expenses: Expense.netAmount for status in
 *     [booked, deductible]. Categorised by
 *     expense.category: anything that starts with
 *     "Material" or "Waren" → Materialaufwand;
 *     everything else → Sonstige. Personal is a
 *     known gap (no payroll module yet) — a v2
 *     could integrate with a future Lohn module.
 *
 * The output is a 12-month series + a YTD row,
 * plus a comparison column vs the previous year
 * (so the user can spot month-over-month and
 * year-over-year trends in one view).
 */

export interface PnlMonth {
  /** YYYY-MM */
  month: string;
  revenue: number;
  materialExpenses: number;
  otherExpenses: number;
  /** revenue - materialExpenses - otherExpenses */
  operatingResult: number;
  /** Net VAT (informational — not part of P&L math) */
  vat: number;
  /** Same shape as operatingResult, but for the prior
   *  calendar year. null if no data or at year
   *  boundary. */
  priorYearOperatingResult: number | null;
  /** % change vs prior year. null if prior = 0. */
  priorYearChangePercent: number | null;
}

export interface PnlResult {
  year: number;
  months: PnlMonth[];
  ytd: {
    revenue: number;
    materialExpenses: number;
    otherExpenses: number;
    operatingResult: number;
    vat: number;
  };
  priorYearYtd: {
    revenue: number;
    materialExpenses: number;
    otherExpenses: number;
    operatingResult: number;
    vat: number;
  };
  generatedAt: string;
  counts: {
    invoices: number;
    expenses: number;
  };
}


@Injectable()
export class PnlService {
  constructor(private prisma: PrismaService) {}

  async compute(companyId: string, year: number): Promise<PnlResult> {
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

    // Expenses: 12 months × (material, all) for the
    // current and the prior year, aggregated in
    // parallel. Invoices: one row read per year (below).
    const months = Array.from({ length: 12 }, (_, idx) => {
      const mStart = new Date(year, idx, 1);
      const mEnd = new Date(year, idx + 1, 0, 23, 59, 59, 999);
      const pStart = new Date(year - 1, idx, 1);
      const pEnd = new Date(year - 1, idx + 1, 0, 23, 59, 59, 999);
      return { idx, mStart, mEnd, pStart, pEnd };
    });

    // Tier 362: invoices are summed row by row. Revenue used to be a per-month
    // `aggregate` whose `_sum.eurSubtotal` was taken whenever it was non-null —
    // i.e. as soon as ONE row in the month had an EUR amount — so every row
    // whose eurSubtotal is NULL silently dropped out of that month's revenue
    // (e2e/142 measured a 2.97 EUR "delta" for two 1000-unit invoices). NULL is
    // not only legacy data: until Tier 362 recurring.service.ts never set the
    // EUR columns. BWA, GuV and EÜR already fall back per row; this now matches.
    // Tier 424: issued sales documents — drafts and Proformas are no revenue
    // (drafts were counted here, unlike BWA / GuV / EÜR).
    const invoiceStatuses = ISSUED_STATUSES
    const invoiceSelect = {
      issueDate: true,
      subtotal: true,
      total: true,
      totalVat: true,
      eurSubtotal: true,
      eurTotal: true,
      eurTotalVat: true,
    } as const
    const [cyInvoices, pyInvoices] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { companyId, issueDate: { gte: yearStart, lte: yearEnd }, status: { in: invoiceStatuses }, type: { in: SALES_TYPES } },
        select: invoiceSelect,
      }),
      this.prisma.invoice.findMany({
        where: {
          companyId,
          issueDate: { gte: new Date(year - 1, 0, 1), lte: new Date(year - 1, 11, 31, 23, 59, 59, 999) },
          status: { in: invoiceStatuses },
          type: { in: SALES_TYPES },
        },
        select: invoiceSelect,
      }),
    ]);
    const cash = await cashBookings(this.prisma, companyId, new Date(year - 1, 0, 1), yearEnd)
    // EUR amount per row, falling back to the original-currency amount when
    // the EUR column is NULL. Summed as Decimal (Tier 216/245 convention).
    const sumInvoices = (rows: typeof cyInvoices, from: Date, to: Date) => {
      let revenue = new Prisma.Decimal(0)
      let vat = new Prisma.Decimal(0)
      for (const r of rows) {
        if (r.issueDate < from || r.issueDate > to) continue
        // Tier 425: net after the invoice discount (invoiceNetRevenue, as
        // GuV / BWA / EÜR since Tier 411) — this took the subtotal before it.
        revenue = revenue.plus(invoiceNetRevenue(r))
        vat = vat.plus(r.eurTotalVat ?? r.totalVat ?? 0)
      }
      // Tier 425: cash sales from the Kassenbuch (cash-bookings.ts).
      for (const c of cash) {
        if (c.direction !== 'in' || c.date < from || c.date > to) continue
        revenue = revenue.plus(c.net)
        vat = vat.plus(c.vat)
      }
      return { revenue: revenue.toNumber(), vat: vat.toNumber() }
    }
    // Tier 440: the book value of assets sold or scrapped counts with the
    // cash purchases as an other expense (disposals.ts).
    const disposals = await assetDisposals(this.prisma, companyId, new Date(year - 1, 0, 1), yearEnd)
    const cashOut = (from: Date, to: Date) =>
      cash.filter((c) => c.direction === 'out' && c.date >= from && c.date <= to).reduce((s, c) => s + c.net, 0)
      + disposals.filter((d) => d.date >= from && d.date <= to).reduce((s, d) => s + d.restbuchwert, 0)

    // Tier 466: the expenses of both years in two queries, bucketed per month
    // here. This fired 12 months × 6 `aggregate` calls at once (72 parallel
    // queries): under load the pool's connection setup failed and the P&L
    // answered 500 "Can't reach database server" (ErrorEvent of a local e2e
    // run, spec 213). Same buckets as before:
    //   mat — booked/deductible, category Material… / Waren…
    //   exp — booked/deductible, no AfA row (NOT_AFA_BOOKING)
    //   afa — the rows "AfA buchen" created (relatedAssetId), any status;
    //         negative, so subtracting them adds the AfA as a cost (Tier 437)
    const expenseRows = (start: Date, end: Date) =>
      this.prisma.expense.findMany({
        where: { companyId, invoiceDate: { gte: start, lte: end } },
        select: { invoiceDate: true, netAmount: true, category: true, status: true, relatedAssetId: true },
      })
    const [cyExpenses, pyExpenses] = await Promise.all([
      expenseRows(yearStart, yearEnd),
      expenseRows(new Date(year - 1, 0, 1), new Date(year - 1, 11, 31, 23, 59, 59, 999)),
    ])
    type Buckets = { mat: number; exp: number; afa: number }
    const bucketByMonth = (rows: typeof cyExpenses) => {
      const out = new Map<number, Buckets>()
      for (const e of rows) {
        const idx = e.invoiceDate.getMonth()
        const b = out.get(idx) ?? { mat: 0, exp: 0, afa: 0 }
        const cents = Math.round(Number(e.netAmount ?? 0) * 100)
        const booked = e.status === 'booked' || e.status === 'deductible'
        if (booked && /^(Material|Waren)/.test(e.category ?? '')) b.mat += cents
        if (booked && e.relatedAssetId == null) b.exp += cents
        if (e.relatedAssetId != null) b.afa += cents
        out.set(idx, b)
      }
      return out
    }
    const cyBuckets = bucketByMonth(cyExpenses)
    const pyBuckets = bucketByMonth(pyExpenses)
    const eur = (cents: number | undefined) => (cents ?? 0) / 100

    const result: PnlMonth[] = months.map((m) => {
      const cy = cyBuckets.get(m.idx)
      const py = pyBuckets.get(m.idx)
      const { revenue, vat } = sumInvoices(cyInvoices, m.mStart, m.mEnd)
      const mat = eur(cy?.mat);
      const totalExp = eur(cy?.exp) + cashOut(m.mStart, m.mEnd) - eur(cy?.afa);
      const otherExp = Math.max(0, totalExp - mat);
      const operatingResult = revenue - mat - otherExp;
      // Prior year
      const pRev = sumInvoices(pyInvoices, m.pStart, m.pEnd).revenue
      const pMat = eur(py?.mat);
      const pTotal = eur(py?.exp) + cashOut(m.pStart, m.pEnd) - eur(py?.afa);
      const pOther = Math.max(0, pTotal - pMat);
      const pOp = pRev - pMat - pOther;
      // % change. Guard against div by zero.
      let pct: number | null = null
      if (pOp !== 0) {
        pct = Math.round(((operatingResult - pOp) / Math.abs(pOp)) * 1000) / 10
      } else if (operatingResult !== 0) {
        pct = 100
      }
      return {
        month: `${year}-${String(m.idx + 1).padStart(2, '0')}`,
        revenue,
        materialExpenses: mat,
        otherExpenses: otherExp,
        operatingResult,
        vat,
        priorYearOperatingResult: pOp !== 0 ? pOp : null,
        priorYearChangePercent: pct,
      };
    });

    // YTD = sum of all 12 months.
    const sum = (key: keyof PnlMonth) =>
      result.reduce((s, m) => s + (m[key] as number || 0), 0);
    const ytd = {
      revenue: sum('revenue'),
      materialExpenses: sum('materialExpenses'),
      otherExpenses: sum('otherExpenses'),
      operatingResult: sum('operatingResult'),
      vat: sum('vat'),
    };
    const priorYearYtd = {
      // prior-year revenue + expenses for the YTD
      // comparison row. We only surfaced operatingResult
      // per month in the UI; the per-bucket breakdown
      // is informational and can be expanded in a v2.
      revenue: 0,
      materialExpenses: 0,
      otherExpenses: 0,
      operatingResult: result.reduce(
        (s, m) => s + (m.priorYearOperatingResult || 0),
        0,
      ),
      vat: 0,
    };

    // Counts (used by the UI to show "X Rechnungen
    // + Y Ausgaben in diesem Zeitraum")
    const [invCount, expCount] = await Promise.all([
      this.prisma.invoice.count({
        where: {
          companyId,
          issueDate: { gte: yearStart, lte: yearEnd },
        },
      }),
      this.prisma.expense.count({
        where: {
          companyId,
          invoiceDate: { gte: yearStart, lte: yearEnd },
          status: { in: ['booked', 'deductible'] },
        },
      }),
    ]);

    return {
      year,
      months: result,
      ytd,
      priorYearYtd,
      generatedAt: new Date().toISOString(),
      counts: { invoices: invCount, expenses: expCount },
    };
  }
}
