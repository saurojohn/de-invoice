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
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { CLAIM_TYPES, ISSUED_STATUSES } from '../invoice/document-scope'
import { invoiceNetRevenue } from '../invoice/tax-breakdown'

export interface Inflow<T> {
  invoice: T
  /** net income in EUR, negative for a credit note's refund */
  amount: number
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
} as const

const CENT = 0.005
const inYear = (d: Date, start: Date, end: Date) => d >= start && d <= end

export async function euerInflows(prisma: PrismaService, companyId: string, start: Date, end: Date) {
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      type: { in: CLAIM_TYPES },
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
        inflows.push({ invoice: inv, amount: invoiceNetRevenue(inv) })
      }
      continue
    }
    if (total === 0) continue
    const share = invoiceNetRevenue(inv) / total
    let open = total
    let amount = 0
    for (const p of inv.payments) {
      const part = Math.min(Number(p.amount), open)
      if (part <= 0) break
      open -= part
      if (p.paymentMethod !== 'Gutschrift' && inYear(p.paymentDate, start, end)) amount += part * share
    }
    if (inv.status === 'paid' && open > CENT && inYear(inv.issueDate, start, end)) amount += open * share
    if (Math.abs(amount) > 1e-9) inflows.push({ invoice: inv, amount })
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
    if (beyond > CENT) inflows.push({ invoice: cn, amount: (invoiceNetRevenue(cn) / gross) * beyond })
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
      select: { netAmount: true, grossAmount: true, category: true },
    }),
    prisma.expense.count({
      where: { ...scope, paidAt: null, invoiceDate: { gte: start, lte: end } },
    }),
  ])
  return { expenses, unpaidExpenses }
}
