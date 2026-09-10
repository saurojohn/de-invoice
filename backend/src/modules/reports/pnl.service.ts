import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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

    // 24 parallel queries: 12 months × (revenue,
    // material, other, vat) for the current year, plus
    // 12 months × same for the prior year. We do
    // them all in parallel because the per-month
    // cost is identical and we want one round-trip
    // to Postgres.
    const months = Array.from({ length: 12 }, (_, idx) => {
      const mStart = new Date(year, idx, 1);
      const mEnd = new Date(year, idx + 1, 0, 23, 59, 59, 999);
      const pStart = new Date(year - 1, idx, 1);
      const pEnd = new Date(year - 1, idx + 1, 0, 23, 59, 59, 999);
      return { idx, mStart, mEnd, pStart, pEnd };
    });

    const monthlyResults = await Promise.all(
      months.flatMap((m) => [
        // Revenue + VAT for the current year
        this.prisma.invoice.aggregate({
          where: {
            companyId,
            issueDate: { gte: m.mStart, lte: m.mEnd },
            status: { in: ['paid', 'sent', 'overdue', 'draft'] },
          },
          // Tier 118.5: aggregate the EUR equivalents
          // (eurSubtotal / eurTotalVat). The PnL is a
          // German BWA-style form that sums everything
          // in EUR regardless of source currency. The
          // raw subtotal / totalVat columns are
          // summed too for the fallback path (legacy
          // rows where eurSubtotal is null). The
          // service below picks eurSubtotal first.
          _sum: { subtotal: true, totalVat: true, eurSubtotal: true, eurTotalVat: true },
          _count: { _all: true },
        }).then((r) => ({ kind: 'cy' as const, idx: m.idx, value: r })),
        // Material expenses for the current year.
        // Categorise: category starts with "Material"
        // or "Waren" → Material; everything else →
        // Sonstige. The Material bucket is the sum,
        // the Sonstige bucket is the sum minus the
        // Material bucket.
        this.prisma.expense.aggregate({
          where: {
            companyId,
            invoiceDate: { gte: m.mStart, lte: m.mEnd },
            status: { in: ['booked', 'deductible'] },
            OR: [
              { category: { startsWith: 'Material' } },
              { category: { startsWith: 'Waren' } },
            ],
          },
          _sum: { netAmount: true },
          _count: { _all: true },
        }).then((r) => ({ kind: 'cyMat' as const, idx: m.idx, value: r })),
        this.prisma.expense.aggregate({
          where: {
            companyId,
            invoiceDate: { gte: m.mStart, lte: m.mEnd },
            status: { in: ['booked', 'deductible'] },
          },
          _sum: { netAmount: true },
          _count: { _all: true },
        }).then((r) => ({ kind: 'cyExp' as const, idx: m.idx, value: r })),
        // Prior year aggregates (only the operating
        // result is exposed in the UI, but we also
        // surface revenue / expenses for transparency)
        this.prisma.invoice.aggregate({
          where: {
            companyId,
            issueDate: { gte: m.pStart, lte: m.pEnd },
            status: { in: ['paid', 'sent', 'overdue', 'draft'] },
          },
          // Tier 118.5: prior-year aggregation in EUR
          _sum: { subtotal: true, totalVat: true, eurSubtotal: true, eurTotalVat: true },
        }).then((r) => ({ kind: 'py' as const, idx: m.idx, value: r })),
        this.prisma.expense.aggregate({
          where: {
            companyId,
            invoiceDate: { gte: m.pStart, lte: m.pEnd },
            status: { in: ['booked', 'deductible'] },
            OR: [
              { category: { startsWith: 'Material' } },
              { category: { startsWith: 'Waren' } },
            ],
          },
          _sum: { netAmount: true },
        }).then((r) => ({ kind: 'pyMat' as const, idx: m.idx, value: r })),
        this.prisma.expense.aggregate({
          where: {
            companyId,
            invoiceDate: { gte: m.pStart, lte: m.pEnd },
            status: { in: ['booked', 'deductible'] },
          },
          _sum: { netAmount: true },
        }).then((r) => ({ kind: 'pyExp' as const, idx: m.idx, value: r })),
      ]),
    );

    // Group by month index.
    type AggRow = { _sum: Record<string, any>; _count?: { _all: number } };
    const byMonth = new Map<number, Record<string, AggRow>>();
    for (const r of monthlyResults) {
      const slot = byMonth.get(r.idx) || {};
      slot[r.kind] = r.value as any;
      byMonth.set(r.idx, slot);
    }

    const result: PnlMonth[] = months.map((m) => {
      const s = byMonth.get(m.idx) || {};
      // Tier 118.5: prefer eurSubtotal / eurTotalVat
      // (pre-computed at issue time from the ECB rate)
      // over the original-currency subtotal / totalVat.
      // Fall back to the original amounts for legacy
      // rows where the EUR columns are still null.
      const sumEur = (s_?: AggRow, eurKey?: 'eurSubtotal' | 'eurTotalVat', origKey?: 'subtotal' | 'totalVat') => {
        const eur = s_?._sum?.[eurKey!]
        if (eur != null) return Number(eur)
        return Number(s_?._sum?.[origKey!] || 0)
      }
      const revenue = sumEur(s.cy, 'eurSubtotal', 'subtotal')
      const vat = sumEur(s.cy, 'eurTotalVat', 'totalVat')
      const mat = Number(s.cyMat?._sum?.netAmount || 0);
      const totalExp = Number(s.cyExp?._sum?.netAmount || 0);
      const otherExp = Math.max(0, totalExp - mat);
      const operatingResult = revenue - mat - otherExp;
      // Prior year
      const pRev = sumEur(s.py, 'eurSubtotal', 'subtotal')
      const pMat = Number(s.pyMat?._sum?.netAmount || 0);
      const pTotal = Number(s.pyExp?._sum?.netAmount || 0);
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
