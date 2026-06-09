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
  oldestDaysOverdue: number;
}

export interface AgingReport {
  companyId: string;
  asOf: string;
  totals: Record<AgingBucket, number>;
  grandTotal: number;
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
        oldestDaysOverdue: 0,
      }
      existing.invoiceCount += 1
      existing.buckets[bucket] = Math.round((existing.buckets[bucket] + open) * 100) / 100
      existing.totalOpen = Math.round((existing.totalOpen + open) * 100) / 100
      if (daysOverdue > existing.oldestDaysOverdue) existing.oldestDaysOverdue = daysOverdue
      byCustomer.set(key, existing)
    }

    // Build totals
    const totals: Record<AgingBucket, number> = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 }
    for (const row of byCustomer.values()) {
      for (const b of BUCKET_ORDER) {
        totals[b] = Math.round((totals[b] + row.buckets[b]) * 100) / 100
      }
    }
    const grandTotal = Math.round(BUCKET_ORDER.reduce((s, b) => s + totals[b], 0) * 100) / 100

    // Sort rows by totalOpen desc (biggest debtor first)
    const rows = Array.from(byCustomer.values()).sort((a, b) => b.totalOpen - a.totalOpen)

    return {
      companyId,
      asOf: asOf.toISOString(),
      totals,
      grandTotal,
      customerCount: rows.length,
      rows,
    }
  }
}
