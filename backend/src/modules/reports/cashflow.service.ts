import { NOT_AFA_BOOKING } from '../accounting/booked-afa'
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CLAIM_TYPES } from '../invoice/document-scope'

/**
 * Tier 74: Cash Flow Forecast (Liquiditätsplanung).
 *
 * Predicts the company's bank balance for the next
 * N months (default 12) by combining:
 *
 *   INCOMING (receivables — money in):
 *     - Open invoices (status sent / overdue) with
 *       a dueDate in the forecast window. The expected
 *       cash is invoice.total - sum(payments.amount)
 *       (i.e. the open balance, not the gross total).
 *     - Active recurring templates projected forward
 *       by their interval, until either N occurrences
 *       or endDate is reached. (Treated as 100%
 *       collected; a v2 could weight by historical
 *       collection rate.)
 *
 *   OUTGOING (payables — money out):
 *     - Open expenses (status booked, isDeductible
 *       would be too strict for v1). We use
 *       expense.invoiceDate (the Eingangsrechnungs-
 *       datum). Many small businesses pay on receipt
 *       of the supplier invoice; a v2 could honour
 *       a separate dueDate column.
 *     - Recurring expenses are NOT modelled yet
 *       (the expense module has no recurring
 *       templates — they're invoice-only).
 *
 *   STARTING BALANCE:
 *     The caller passes `startingBalance` (the
 *     current bank balance) as a query param. We
 *     don't auto-derive it from bank-import
 *     because (a) the bank sync may be stale and
 *     (b) some users have multiple bank accounts
 *     they want to net. UI lets the user type
 *     the value.
 *
 * Output shape is designed for a 12-month bar chart:
 * each month has incoming / outgoing / net /
 * cumulative, plus an `isDry` flag if the
 * cumulative balance would go negative.
 */

export interface CashFlowMonth {
  /** YYYY-MM */
  month: string;
  /** German-formatted: "August 2026" */
  label: string;
  incoming: number;
  outgoing: number;
  /** incoming - outgoing */
  net: number;
  /** Starting balance + sum(net of all prior months) + this month */
  cumulative: number;
  isDry: boolean;
}

export interface CashFlowForecastParams {
  companyId: string;
  /** How many months to project. Clamped to 1-36. */
  months?: number;
  /** The current bank balance, supplied by the user. */
  startingBalance?: number;
  /** Anchor month (defaults to start of current month) */
  fromDate?: Date;
}

export interface CashFlowForecastResult {
  companyId: string;
  startingBalance: number;
  months: CashFlowMonth[];
  summary: {
    totalIncoming: number;
    totalOutgoing: number;
    totalNet: number;
    endBalance: number;
    /** First month where cumulative goes negative, or null. */
    firstDryMonth: string | null;
  };
  counts: {
    openInvoices: number;
    openExpenses: number;
    recurringTemplates: number;
  };
  /** When the forecast was generated (ISO string). */
  generatedAt: string;
}

const MONTH_LABELS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

@Injectable()
export class CashFlowService {
  constructor(private prisma: PrismaService) {}

  async forecast(params: CashFlowForecastParams): Promise<CashFlowForecastResult> {
    const months = Math.max(1, Math.min(36, params.months ?? 12));
    const startingBalance = Number(params.startingBalance ?? 0);
    // Anchor at start of current month in server local
    // time. The forecast spans [anchor, anchor + N months).
    const anchor = params.fromDate
      ? new Date(params.fromDate.getFullYear(), params.fromDate.getMonth(), 1)
      : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const end = new Date(anchor.getFullYear(), anchor.getMonth() + months, 1);

    // ── INCOMING: open invoices ──
    // Sent / overdue invoices whose dueDate falls
    // within the forecast window. Drafts excluded
    // (not yet billed). Cancelled excluded.
    const openInvoices = await this.prisma.invoice.findMany({
      where: {
        companyId: params.companyId,
        status: { in: ['sent', 'overdue'] },
        type: { in: CLAIM_TYPES }, // Tier 424: not a Proforma
        dueDate: { gte: anchor, lt: end },
      },
      include: { payments: { select: { amount: true } } },
    });

    // ── INCOMING: recurring templates ──
    // Project each active template forward N times.
    // The actual cash lands in the SAME month as the
    // generation date (issueDate == dueDate for
    // recurring — they're auto-paid by FinTS in
    // most cases). v1 uses issue date = nextRunAt;
    // the actual due date is issueDate + paymentTermDays
    // but we don't have a paymentTermDays column on
    // RecurringInvoice. Simplification: cash in
    // the same month the invoice is generated.
    const templates = await this.prisma.recurringInvoice.findMany({
      where: {
        companyId: params.companyId,
        isActive: true,
        // Templates whose nextRunAt is before our
        // window ends (they'll contribute at least
        // one run inside the window).
        nextRunAt: { lt: end },
      },
      include: {
        // Pull the items so we can sum grossAmount.
        // Tier 74: the template itself doesn't carry
        // a total — each RecurringInvoiceItem has
        // quantity + unitPrice + vatRate. A v2 could
        // denormalise the total onto the template
        // for faster forecast, but for a few hundred
        // templates per company the join is fine.
        items: { select: { quantity: true, unitPrice: true, vatRate: true } },
      },
    });

    // Pre-compute each template's per-occurrence
    // gross total once, so the inner loop just
    // adds the cached value. Formula per item:
    //   gross = quantity * unitPrice * (1 + vatRate)
    // (same formula invoice.service.ts uses when
    // generating the actual invoice).
    const templateAmounts = new Map<string, number>()
    for (const t of templates) {
      let sum = 0
      for (const it of t.items) {
        const q = Number(it.quantity)
        const p = Number(it.unitPrice)
        const r = Number(it.vatRate)
        sum += q * p * (1 + r)
      }
      templateAmounts.set(t.id, sum)
    }

    // ── OUTGOING: open expenses ──
    // Status `booked` is the default; we treat it
    // as "still owed". If a v2 adds a `paidAt`
    // column, we can subtract those.
    const openExpenses = await this.prisma.expense.findMany({
      where: {
        companyId: params.companyId,
        status: { in: ['booked', 'deductible'] },
        invoiceDate: { gte: anchor, lt: end },
        ...NOT_AFA_BOOKING, // Tier 437: AfA moves no money
      },
      select: { grossAmount: true, invoiceDate: true },
    });

    // ── Bucket everything into the N month cells ──
    const cells: CashFlowMonth[] = [];
    for (let i = 0; i < months; i++) {
      const m = new Date(anchor.getFullYear(), anchor.getMonth() + i, 1);
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
      cells.push({
        month: key,
        label: `${MONTH_LABELS_DE[m.getMonth()]} ${m.getFullYear()}`,
        incoming: 0,
        outgoing: 0,
        net: 0,
        cumulative: 0,
        isDry: false,
      });
    }
    const indexByMonth = new Map(cells.map((c, i) => [c.month, i]));

    for (const inv of openInvoices) {
      if (!inv.dueDate) continue;
      const d = new Date(inv.dueDate);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const idx = indexByMonth.get(key);
      if (idx === undefined) continue;
      const paid = inv.payments.reduce(
        (s, p) => s.plus(p.amount ?? new Prisma.Decimal(0)),
        new Prisma.Decimal(0),
      ).toNumber();
      const open = Math.max(0, Number(inv.total) - paid);
      cells[idx].incoming += open;
    }

    for (const t of templates) {
      // Walk forward by interval, generating up to N
      // occurrences within [anchor, end).
      let d = new Date(t.nextRunAt);
      while (d < end) {
        if (d >= anchor) {
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          const idx = indexByMonth.get(key);
          if (idx !== undefined) {
            // Sum the template's items. Falls back
            // to 0 for templates that have no items
            // (empty draft). Cached in templateAmounts
            // so we don't re-sum on every iteration.
            cells[idx].incoming += templateAmounts.get(t.id) ?? 0;
          }
        }
        // Advance to the next run.
        d = this.advanceBy(d, t.interval, t.intervalCount ?? 1);
        // Respect endDate if set.
        if (t.endDate && d > new Date(t.endDate)) break;
      }
    }

    for (const exp of openExpenses) {
      if (!exp.invoiceDate) continue;
      const d = new Date(exp.invoiceDate);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const idx = indexByMonth.get(key);
      if (idx === undefined) continue;
      cells[idx].outgoing += Number(exp.grossAmount);
    }

    // Compute net + cumulative + isDry.
    let running = startingBalance;
    let firstDryMonth: string | null = null;
    for (const c of cells) {
      c.net = c.incoming - c.outgoing;
      running += c.net;
      c.cumulative = running;
      if (running < 0 && firstDryMonth === null) {
        firstDryMonth = c.month;
      }
      c.isDry = running < 0;
    }

    const totalIncoming = cells.reduce((s, c) => s + c.incoming, 0);
    const totalOutgoing = cells.reduce((s, c) => s + c.outgoing, 0);

    return {
      companyId: params.companyId,
      startingBalance,
      months: cells,
      summary: {
        totalIncoming,
        totalOutgoing,
        totalNet: totalIncoming - totalOutgoing,
        endBalance: running,
        firstDryMonth,
      },
      counts: {
        openInvoices: openInvoices.length,
        openExpenses: openExpenses.length,
        recurringTemplates: templates.length,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Advance a date by N units of interval (mirrors
   * the logic in RecurringService.advanceTo but kept
   * private to this service — the recurring service
   * is for generation, this is for projection).
   *
   * Intervals: weekly | monthly | quarterly | yearly.
   */
  private advanceBy(d: Date, interval: string, count: number): Date {
    const next = new Date(d);
    const n = Math.max(1, count);
    switch (interval) {
      case 'weekly':
        next.setDate(next.getDate() + 7 * n);
        break;
      case 'monthly':
        next.setMonth(next.getMonth() + n);
        break;
      case 'quarterly':
        next.setMonth(next.getMonth() + 3 * n);
        break;
      case 'yearly':
        next.setFullYear(next.getFullYear() + n);
        break;
      default:
        // Unknown interval — treat as monthly to
        // avoid an infinite loop. The DB schema
        // doesn't enforce interval ∈ {weekly,...}
        // so this is defensive.
        next.setMonth(next.getMonth() + n);
    }
    return next;
  }
}
