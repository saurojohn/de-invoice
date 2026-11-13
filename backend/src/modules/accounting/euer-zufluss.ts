/**
 * Tier 454 — the EÜR's income and expenses by the day the money moved
 * (Zufluss-/Abflussprinzip, § 11 EStG).
 *
 * The Anlage EÜR took every sent invoice at its issue date and every expense
 * at its invoice date. § 4 Abs. 3 EStG counts payments: an invoice of
 * November paid in January is income of the new year, an unpaid invoice no
 * income yet, a bill paid in January a cost of January's year.
 *
 * Income is each payment's net share of its invoice (payment × net / gross,
 * in EUR through the invoice's own net — invoiceNetRevenue), in date order up
 * to the invoice's total:
 *   - a credit note settling the invoice ('Gutschrift' payment, also the
 *     Skonto of Tier 422) takes up its part of the invoice and is no income
 *   - an overpayment beyond the total is no income of this invoice — it
 *     becomes the customer's credit, and counts when that credit pays an
 *     invoice ('Guthaben' payment)
 *   - an invoice set "paid" without its payments recorded counts the part
 *     no payment covers at its issue date (the only date there is); so does
 *     a paid negative invoice (a correction entered as INV), negatively
 * A credit note's amount beyond what it settled on its invoice (the invoice
 * was already paid: the customer gets money or credit back) lowers the income
 * at the credit note's date.
 *
 * Expenses count at `paidAt` — set by the bank import, the SEPA run, the cash
 * book, or entered by hand (Tier 454).
 */
import { Ku, kuAt, kuDayOf } from '../../common/kleinunternehmer-period'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { CLAIM_TYPES, ISSUED_STATUSES } from '../invoice/document-scope'
import { invoiceNetRevenue } from '../invoice/tax-breakdown'
import { ADVANCE_SETTLEMENT_METHOD } from '../invoice/advance'

export interface Inflow<T> {
  invoice: T
  /** net income in EUR, negative for a credit note's refund */
  amount: number
  /**
   * Tier 457: the part of the document counted in the period (0–1), to apply
   * to its own amounts — per VAT rate for the Ist-Versteuerung (ustva-ist.ts).
   */
  fraction: number
}

const INVOICE_FIELDS = {
  id: true,
  type: true,
  invoiceNumber: true,
  issueDate: true,
  status: true,
  referenceInvoiceId: true,
  subtotal: true,
  totalVat: true,
  total: true,
  eurSubtotal: true,
  eurTotalVat: true,
  eurTotal: true,
  reverseCharge: true,
  euTransaction: true,
  // Tier 844: a credit note follows the invoice it corrects (its line, its § 19)
  referenceInvoice: {
    select: { issueDate: true, subtotal: true, totalVat: true, reverseCharge: true, euTransaction: true },
  },
} as const

const CENT = 0.005
const inYear = (d: Date, start: Date, end: Date) => d >= start && d <= end

export async function euerInflows(prisma: PrismaService, companyId: string, start: Date, end: Date) {
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      // Tier 470: a payment on a Proforma is an advance payment (Anzahlung) —
      // income when received (§ 11 EStG), and its output tax is due then
      // (§ 13 Abs. 1 Nr. 1a Satz 4 UStG; the UStVA adds it via
      // advancePayments below). It counted nowhere.
      type: { in: [...CLAIM_TYPES, 'PI'] },
      status: { in: ISSUED_STATUSES },
      OR: [
        { payments: { some: { paymentDate: { gte: start, lte: end } } } },
        { status: 'paid', issueDate: { gte: start, lte: end } },
      ],
    },
    select: {
      ...INVOICE_FIELDS,
      payments: {
        select: { amount: true, paymentDate: true, paymentMethod: true },
        orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
      },
    },
  })
  type EuerInvoice = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_FIELDS }>
  const inflows: Inflow<EuerInvoice>[] = []
  for (const inv of invoices) {
    const total = Number(inv.total)
    if (total < 0) {
      // A correction entered as a negative invoice: paid out when it says
      // "paid" — no payment row records a refund, so at its issue date.
      if (inv.status === 'paid' && inYear(inv.issueDate, start, end)) {
        inflows.push({ invoice: inv, amount: invoiceNetRevenue(inv), fraction: 1 })
      }
      continue
    }
    if (total === 0) continue
    const share = invoiceNetRevenue(inv) / total
    let open = total
    let counted = 0
    for (const p of inv.payments) {
      // Tier 475: a refund (negative payment — an advance paid back) is
      // negative income in its period, up to what had been received.
      const part = Number(p.amount) < 0
        ? Math.max(Number(p.amount), open - total)
        : Math.min(Number(p.amount), open)
      if (part === 0) continue
      open -= part
      // Tier 472: the advance a final invoice deducts ('Anzahlung') was
      // income when it was received on the Proforma.
      if (p.paymentMethod !== 'Gutschrift' && p.paymentMethod !== ADVANCE_SETTLEMENT_METHOD && inYear(p.paymentDate, start, end)) counted += part
    }
    if (inv.status === 'paid' && open > CENT && inYear(inv.issueDate, start, end)) counted += open
    if (Math.abs(counted) > 1e-9) inflows.push({ invoice: inv, amount: counted * share, fraction: counted / total })
  }

  // Credit notes of the year: the part beyond what they settled on their invoice.
  const creditNotes = await prisma.invoice.findMany({
    where: {
      companyId,
      type: 'CN',
      status: { in: ISSUED_STATUSES },
      issueDate: { gte: start, lte: end },
    },
    select: INVOICE_FIELDS,
  })
  const settled = creditNotes.length
    ? await prisma.payment.findMany({
      where: {
        paymentMethod: 'Gutschrift',
        invoice: { companyId },
        reference: { in: creditNotes.map((cn) => `CN ${cn.invoiceNumber}`) },
      },
      select: { reference: true, amount: true, invoiceId: true },
    })
    : []
  for (const cn of creditNotes) {
    const gross = Math.abs(Number(cn.total))
    if (!(gross > 0)) continue
    const offset = settled
      .filter((p) => p.reference === `CN ${cn.invoiceNumber}` && p.invoiceId === cn.referenceInvoiceId)
      .reduce((s, p) => s + Number(p.amount), 0)
    const beyond = gross - offset
    if (beyond > CENT) {
      inflows.push({ invoice: cn, amount: (invoiceNetRevenue(cn) / gross) * beyond, fraction: beyond / gross })
    }
  }

  // Issued in the year and not (fully) paid yet — counted when they are.
  const unpaidInvoices = await prisma.invoice.count({
    where: {
      companyId,
      type: { in: CLAIM_TYPES },
      status: { in: ['sent', 'overdue'] },
      issueDate: { gte: start, lte: end },
    },
  })
  return { inflows, unpaidInvoices }
}

/**
 * Expenses paid in the year (Abfluss), and those dated in the year not paid
 * yet. Booked AfA rows are no expense here — the annexes have their own AfA
 * line (Tier 87 / 436).
 */
export async function euerExpenses(prisma: PrismaService, companyId: string, start: Date, end: Date) {
  const scope = {
    companyId,
    status: { in: ['booked', 'deductible'] },
    // Tier 425: `not: 'AfA'` alone is `category <> 'AfA'` in SQL, which drops every
    // expense WITHOUT a category (NULL) — the usual case.
    OR: [{ category: null }, { category: { not: 'AfA' } }],
  }
  const [expenses, unpaidExpenses] = await Promise.all([
    prisma.expense.findMany({
      where: { ...scope, paidAt: { gte: start, lte: end } },
      // Tier 483: the input tax paid is its own EÜR line (gezahlte Vorsteuer)
      // Tier 503: id for the gift limit (accounting/gifts.ts)
      // Tier 539: the Bewirtung record, for the hint
      // Tier 842: the date — whether § 19 applied to the bill (kleinunternehmer-period.ts)
      select: { id: true, netAmount: true, grossAmount: true, vatAmount: true, category: true, accountNumber: true, bewirtungAnlass: true, bewirtungTeilnehmer: true, invoiceDate: true },
    }),
    prisma.expense.count({
      where: { ...scope, paidAt: null, invoiceDate: { gte: start, lte: end } },
    }),
  ])
  return { expenses, unpaidExpenses }
}

/**
 * Tier 470 — advance payments: the payments received on a Proforma in the
 * period, as the part of the Proforma they pay (for the UStVA of a
 * Soll-Versteuerer; an Ist-Versteuerer gets them through euerInflows).
 */
export async function advancePayments(prisma: PrismaService, companyId: string, start: Date, end: Date) {
  const { inflows } = await euerInflows(prisma, companyId, start, end)
  const pis = inflows.filter((f) => f.invoice.type === 'PI')
  if (pis.length === 0) return []
  const docs = await prisma.invoice.findMany({
    where: { companyId, id: { in: pis.map((f) => f.invoice.id) } },
    include: { items: true, customer: true },
  })
  const byId = new Map(docs.map((d) => [d.id, d]))
  return pis.map((f) => ({ doc: byId.get(f.invoice.id)!, fraction: f.fraction })).filter((x) => !!x.doc)
}

/**
 * Tier 472 — advances settled by a final invoice in the period: the
 * 'Anzahlung' payment its issue books, with the Proforma (and its items) and
 * the part of the Proforma it settles. The final invoice states the whole
 * delivery with its tax; the tax already paid on the advance comes off again
 * in the same period (§ 14 Abs. 5 Satz 2 UStG).
 */
export async function advanceSettlements(prisma: PrismaService, companyId: string, start: Date, end: Date) {
  const rows = await prisma.payment.findMany({
    where: {
      paymentMethod: ADVANCE_SETTLEMENT_METHOD,
      paymentDate: { gte: start, lte: end },
      invoice: { companyId, status: { notIn: ['draft', 'cancelled'] }, advanceInvoiceId: { not: null } },
    },
    include: {
      invoice: {
        select: { id: true, invoiceNumber: true, customerId: true, advanceInvoice: { include: { items: true, customer: true } } },
      },
    },
    orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.flatMap((p) => {
    const pi = p.invoice.advanceInvoice
    const total = Number(pi?.total ?? 0)
    if (!pi || !(total > 0)) return []
    return [{ payment: p, finalInvoice: p.invoice, proforma: pi, fraction: Number(p.amount) / total }]
  })
}

/**
 * Tier 483 — the VAT settled with the Finanzamt in the period (Anlage EÜR
 * Zeile 18: refunded, Zeile 58: paid), from the payments recorded on the
 * UStVA filings (UStvaFiling.paidAt / paidAmount).
 */
export async function finanzamtVat(prisma: PrismaService, companyId: string, start: Date, end: Date) {
  const [filings, others] = await Promise.all([
    prisma.uStvaFiling.findMany({
      where: { companyId, paidAt: { gte: start, lte: end }, paidAmount: { not: null } },
      select: { paidAmount: true },
    }),
    // Tier 484: UStJA Abschlusszahlung / Erstattung, Sondervorauszahlung, other
    prisma.ustPayment.findMany({
      where: { companyId, paidAt: { gte: start, lte: end } },
      select: { amount: true },
    }),
  ])
  let paid = 0
  let refunded = 0
  for (const a of [...filings.map((r) => Number(r.paidAmount)), ...others.map((r) => Number(r.amount))]) {
    if (a >= 0) paid += a
    else refunded -= a
  }
  return { paid, refunded }
}

/**
 * Tier 483 — the VAT in the cash flows of an EÜR (§ 4 Abs. 3 EStG): received
 * with the income (the paid part of each document's tax, EUR; a refund
 * negative) and paid with the expenses and cash purchases. A Kleinunternehmer
 * has neither (he charges no VAT, his expenses cost gross). The EÜR and
 * Anlage G (EÜR) take the same figures.
 */
export function euerVat(
  inflows: Array<{
    invoice: {
      eurTotalVat?: unknown; totalVat?: unknown; issueDate?: Date | null
      type?: string | null; referenceInvoice?: { issueDate?: Date | null } | null
    }
    fraction: number
  }>,
  expenses: Array<{ vatAmount?: unknown; category?: string | null; invoiceDate?: Date | null }>,
  cash: Array<{ direction: string; vat: number; date?: Date }>,
  kleinunternehmer: Ku,
) {
  // Tier 842: by the date of each document — a year with the change of
  // regime has both (kleinunternehmer-period.ts)
  let received = 0
  let vorsteuer = 0
  for (const f of inflows) {
    if (kuAt(kleinunternehmer, kuDayOf(f.invoice))) continue // Tier 844: a credit note as its invoice
    received += f.fraction * Number(f.invoice.eurTotalVat ?? f.invoice.totalVat ?? 0)
  }
  for (const e of expenses) {
    if (/^AfA/i.test(e.category || '')) continue
    if (kuAt(kleinunternehmer, e.invoiceDate)) continue
    vorsteuer += Number(e.vatAmount ?? 0)
  }
  for (const c of cash) {
    if (kuAt(kleinunternehmer, c.date)) continue
    if (c.direction === 'in') received += c.vat
    else vorsteuer += c.vat
  }
  return { received, vorsteuer }
}

/**
 * Tier 844 — the Kennziffer of an inflow: the first line whose matcher takes
 * the invoice, else „sonstige“ (4190). A credit note's refund goes on the
 * line of the invoice it corrects (the matchers are asked about that
 * invoice). A refund that no line takes stays on the taxed line (4100), where
 * every refund went before.
 *
 * The matchers ask for positive amounts; a document with negative ones (an
 * invoice of old data entered as a Gutschrift) is shown to them without its
 * sign, so that it reduces the line an invoice of its kind is on.
 */
export function revenueKz<C>(
  inv: { type?: string | null; referenceInvoice?: unknown },
  amount: number,
  lines: Array<{ kz: string; matcher: (inv: any, ctx: C) => boolean }>,
  ctx: C,
): string {
  const of = (inv.type === 'CN' ? inv.referenceInvoice : inv) as { subtotal?: unknown; totalVat?: unknown } | null | undefined
  const unsigned = of && { ...of, subtotal: Math.abs(Number(of.subtotal ?? 0)), totalVat: Math.abs(Number(of.totalVat ?? 0)) }
  const kz = unsigned ? lines.find((d) => d.matcher(unsigned, ctx))?.kz : undefined
  return kz ?? (amount < 0 || inv.type === 'CN' ? '4100' : '4190')
}
