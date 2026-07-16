/**
 * Aging Report — accounts-receivable aged by overdue buckets.
 *
 * For each customer, compute the unpaid amount of their
 * outstanding invoices and bucket it into:
 *   - current   (not yet due)
 *   - 1-30      (1-30 days overdue)
 *   - 31-60
 *   - 61-90
 *   - 90+       (90+ days overdue)
 *
 * The customer's `totalOpen` is the sum across all buckets.
 * Sorted desc by totalOpen so the biggest debtor is at the
 * top — that's what a collections clerk looks at first.
 *
 * Tier 59: also includes the customer's current credit
 * balance (Kundenguthaben) + the net open amount
 * (totalOpen - creditBalance, floored at 0). The net
 * amount is what the Berater should actually pursue:
 * if a customer owes 5.000 EUR but has 200 EUR credit
 * balance, the actionable Mahnung target is 4.800 EUR.
 *
 * Payment handling: an invoice is fully paid when the sum
 * of its `Payment` rows ≥ `invoice.total`. The remaining
 * difference is what ages in the report.
 *
 * Excludes:
 *   - draft invoices (not yet sent to the customer)
 *   - cancelled / storno (if any status hits those)
 *   - credit notes (CN) — those are handled as negative
 *     payment applications, not as a separate open amount
 *
 * SQL approach: load all sent/overdue invoices for the
 * company + their payments in a single round-trip, then
 * bucket in JS. N+1 avoided by the `include` on payments.
 * Credit balances are loaded via a single `groupBy` query
 * (O(1) round-trip) keyed by customerId.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type AgingBucket = 'current' | '1-30' | '31-60' | '61-90' | '90+';

const BUCKET_ORDER: AgingBucket[] = ['current', '1-30', '31-60', '61-90', '90+'];

function bucketFor(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

export interface AgingRow {
  customerId: string;
  customerName: string;
  customerNumber?: string | null;
  invoiceCount: number;
  buckets: Record<AgingBucket, number>;
  totalOpen: number;
  /** Tier 59: customer credit balance (Kundenguthaben).
   *  Positive = customer has credit (overpayment,
   *  Gutschrift overage, manual credit). */
  creditBalance: number;
  /** Tier 59: net open = max(0, totalOpen - creditBalance).
   *  This is the actionable Mahnung target — what the
   *  Berater should actually pursue after applying
   *  available credit. */
  netOpen: number;
  oldestDaysOverdue: number;
}

export interface AgingReport {
  companyId: string;
  asOf: string;
  totals: Record<AgingBucket, number>;
  grandTotal: number;
  /** Tier 59: aggregate credit balance across all
   *  listed customers. Useful for the report header
   *  (e.g. "5.000 EUR offene Posten, 1.200 EUR
   *  Kundenguthaben, 3.800 EUR Netto-Einzug"). */
  totalCreditBalance: number;
  /** Tier 59: grandTotal - totalCreditBalance,
   *  floored at 0. */
  grandNetTotal: number;
  customerCount: number;
  rows: AgingRow[];
}

@Injectable()
export class AgingService {
  constructor(private prisma: PrismaService) {}

  async generate(companyId: string): Promise<AgingReport> {
    const asOf = new Date();
    // Pull all open invoices (sent / overdue) for the company
    // in one round-trip, including payments so we can
    // subtract the paid amount.
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        status: { in: ['sent', 'overdue'] },
        type: { in: ['INV', 'PI'] }, // skip CN, RCV
      },
      include: {
        customer: { select: { id: true, name: true, customerNumber: true } },
        payments: { select: { amount: true } },
      },
    });

    // Bucket per customer
    const byCustomer = new Map<string, AgingRow>()

    for (const inv of invoices) {
      const total = Number(inv.total)
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0)
      const open = Math.max(0, Math.round((total - paid) * 100) / 100)
      if (open <= 0) continue

      const due = inv.dueDate ? new Date(inv.dueDate) : null
      if (!due) continue // no dueDate → can't age, skip
      const daysOverdue = Math.floor((asOf.getTime() - due.getTime()) / (1000 * 60 * 60 * 24))
      const bucket = bucketFor(daysOverdue)

      const key = inv.customer.id
      const existing = byCustomer.get(key) || {
        customerId: inv.customer.id,
        customerName: inv.customer.name,
        customerNumber: inv.customer.customerNumber || null,
        invoiceCount: 0,
        buckets: { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 },
        totalOpen: 0,
        // Tier 59: filled in below from the credit-balance
        // groupBy query. Default 0 — for customers with no
        // ledger rows, the groupBy won't include them and
        // we fall through to 0.
        creditBalance: 0,
        // Tier 59: computed after creditBalance is filled
        // in. Initialised to totalOpen so the late-pass
        // (when the credit balance is 0) still produces
        // netOpen === totalOpen.
        netOpen: 0,
        oldestDaysOverdue: 0,
      }
      existing.invoiceCount += 1
      existing.buckets[bucket] = Math.round((existing.buckets[bucket] + open) * 100) / 100
      existing.totalOpen = Math.round((existing.totalOpen + open) * 100) / 100
      if (daysOverdue > existing.oldestDaysOverdue) existing.oldestDaysOverdue = daysOverdue
      byCustomer.set(key, existing)
    }

    // Tier 59: load every customer's credit balance in a
    // single groupBy round-trip. We don't restrict to the
    // customerIds in the aging report — customers with
    // credit balance but no open invoices still contribute
    // to `totalCreditBalance` / `grandNetTotal` (the
    // header summary line). The per-row map below
    // re-keys the credit totals by customerId; rows that
    // have an open invoice get a per-row creditBalance,
    // the rest contribute to the aggregate only.
    const creditRows = await this.prisma.customerCreditTransaction.groupBy({
      by: ['customerId'],
      where: { companyId },
      _sum: { amount: true },
    })
    const creditByCustomer = new Map<string, number>()
    for (const r of creditRows) {
      creditByCustomer.set(r.customerId, Number(r._sum.amount ?? 0))
    }

    // Apply credit balance + compute netOpen per row.
    // totalCreditBalance sums EVERY customer's credit
    // balance, not just the ones in the byCustomer map
    // (a customer with no open invoices but a positive
    // credit still contributes to the aggregate — the
    // header summary line surfaces the total for the
    // month-end report).
    let totalCreditBalance = 0
    for (const r of creditRows) {
      const cb = Number(r._sum.amount ?? 0)
      totalCreditBalance = Math.round((totalCreditBalance + cb) * 100) / 100
    }
    for (const row of byCustomer.values()) {
      const cb = creditByCustomer.get(row.customerId) ?? 0
      row.creditBalance = Math.round(cb * 100) / 100
      // netOpen = max(0, totalOpen - creditBalance). If a
      // customer has more credit than they owe, the net
      // is 0 (we still list them with their negative
      // credit so the Berater can see the surplus and
      // consider an Auszahlung).
      row.netOpen = Math.max(0, Math.round((row.totalOpen - row.creditBalance) * 100) / 100)
    }

    // Build totals
    const totals: Record<AgingBucket, number> = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
    for (const row of byCustomer.values()) {
      for (const b of BUCKET_ORDER) {
        totals[b] = Math.round((totals[b] + row.buckets[b]) * 100) / 100
      }
    }
    const grandTotal = Math.round(BUCKET_ORDER.reduce((s, b) => s + totals[b], 0) * 100) / 100
    const grandNetTotal = Math.max(
      0,
      Math.round((grandTotal - totalCreditBalance) * 100) / 100,
    )

    // Sort rows by netOpen desc (biggest actionable debtor
    // first). When two customers tie, fall back to totalOpen
    // so a customer with a 0-net but high totalOpen (a
    // credit-surplus case) still surfaces for the
    // Auszahlung decision.
    const rows = Array.from(byCustomer.values()).sort((a, b) => {
      if (b.netOpen !== a.netOpen) return b.netOpen - a.netOpen
      return b.totalOpen - a.totalOpen
    })

    return {
      companyId,
      asOf: asOf.toISOString(),
      totals,
      grandTotal,
      totalCreditBalance,
      grandNetTotal,
      customerCount: rows.length,
      rows,
    }
  }
}
