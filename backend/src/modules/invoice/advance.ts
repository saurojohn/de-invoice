import { NON_CASH_PAYMENT_METHODS } from './document-scope'
import { invoiceTaxBreakdown } from './tax-breakdown'
import { PrismaService } from '../../prisma/prisma.service'

/**
 * Tier 472 — advance payments and the final invoice (Schlussrechnung).
 *
 * A payment on a Proforma (PI) is an advance payment (Tier 470): taxed when
 * received, income when received, a liability until the delivery is invoiced.
 * The final invoice states the whole delivery and deducts what was paid in
 * advance (§ 14 Abs. 5 Satz 2 UStG). The deduction is a payment on the final
 * invoice with the method 'Anzahlung' — no money moves, so it is no cash
 * (NON_CASH_PAYMENT_METHODS): the EÜR and the Ist-Versteuerung do not count
 * it again, while the open balance, the status and the dunning see it.
 */
export const ADVANCE_SETTLEMENT_METHOD = 'Anzahlung'

type Db = {
  payment: { findMany: (args: any) => Promise<Array<{ amount: any }>> }
  invoice: { findFirst: (args: any) => Promise<any> }
}

/** What was received in cash on the Proforma (its currency). */
export async function advanceReceived(db: Db, proformaId: string): Promise<number> {
  const rows = await db.payment.findMany({
    where: { invoiceId: proformaId, paymentMethod: { notIn: NON_CASH_PAYMENT_METHODS } },
    select: { amount: true },
  })
  return Math.round(rows.reduce((s, p) => s + Number(p.amount) * 100, 0)) / 100
}

export interface AdvanceDeduction {
  proformaNumber: string
  /** the day the (last) advance was received */
  receivedOn: Date | null
  gross: number
  /** per VAT rate of the Proforma: the advance's net and tax */
  byRate: Array<{ rate: number; net: number; vat: number }>
}

/**
 * Tier 472: what the final invoice states as deducted (§ 14 Abs. 5 Satz 2
 * UStG — the advance with its net and its tax). The settled amount once
 * issued; on a draft, what has been received so far. Null when the invoice
 * settles no Proforma or nothing was paid on it.
 */
export async function advanceDeductionFor(
  prisma: PrismaService,
  invoice: { id: string; advanceInvoiceId?: string | null },
): Promise<AdvanceDeduction | null> {
  if (!invoice.advanceInvoiceId) return null
  const pi = await prisma.invoice.findFirst({
    where: { id: invoice.advanceInvoiceId },
    include: { items: true, payments: { orderBy: { paymentDate: 'asc' } } },
  })
  if (!pi || !(Number(pi.total) > 0)) return null
  const settled = await prisma.payment.findFirst({
    where: { invoiceId: invoice.id, paymentMethod: ADVANCE_SETTLEMENT_METHOD },
    select: { amount: true },
  })
  const cash = pi.payments.filter((p) => !NON_CASH_PAYMENT_METHODS.includes(p.paymentMethod))
  const gross = settled ? Number(settled.amount) : cash.reduce((s, p) => s + Number(p.amount), 0)
  if (!(gross > 0)) return null
  const fraction = gross / Number(pi.total)
  const r2 = (n: number) => Math.round(n * 100) / 100
  return {
    proformaNumber: pi.invoiceNumber,
    // the last money received, not a refund (Tier 475)
    receivedOn: cash.filter((p) => Number(p.amount) > 0).pop()?.paymentDate ?? null,
    gross: r2(gross),
    byRate: invoiceTaxBreakdown(pi).byRate.map((b) => ({ rate: b.rate, net: r2(b.net * fraction), vat: r2(b.vat * fraction) })),
  }
}

/** The issued final invoice that settles the Proforma, or null. */
export async function settlingInvoice(db: Db, companyId: string, proformaId: string) {
  return db.invoice.findFirst({
    where: { companyId, advanceInvoiceId: proformaId, status: { notIn: ['draft', 'cancelled'] } },
    select: { id: true, invoiceNumber: true },
  })
}
