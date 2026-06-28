// customer-statement.service.ts — Tier 20
//
// Kontoauszug / Customer statement.
//
// Generates a per-customer ledger over a date range, suitable
// for the monthly statement Germany SH Leder sends to their
// B2B customers. The output is used by:
//   - GET /api/v1/customers/:id/statement       (JSON for UI)
//   - GET /api/v1/customers/:id/statement.pdf   (PDF for email)
//
// Ledger rows (German bookkeeping convention):
//
//   Anfangsbestand (debitorischer Saldo vor 'from')
//     + Rechnungen mit issueDate IN [from..to]
//     + Gutschriften (CN) mit issueDate IN [from..to]    (negative)
//     - Zahlungseingänge mit paymentDate IN [from..to]    (reduces open)
//   = Endsaldo (was der Kunde jetzt schuldet)
//
// All amounts in EUR (or whatever currency the customer's
// invoices use — we currently only support per-customer
// single-currency, which matches the Invoice model). The
// output uses German formatting (€ 1.234,56) on the PDF
// layer; the JSON keeps raw numbers (frontend decides).
//
// Open-balance invariant (used by e2e 52):
//   For each row r in [from..to]:
//     running_balance(r) = running_balance(r-1)
//                        + (r.invoice total if r.type='invoice' else 0)
//                        + (r.credit-note total if r.type='credit' else 0)
//                        - (r.payment amount if r.type='payment' else 0)
//   closing_balance = running_balance(last row)
//   opening_balance + sum(lines.delta) === closing_balance

import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'

export interface StatementLine {
  /** Date for sorting / display. For invoices = issueDate,
   *  for payments = paymentDate. */
  date: string
  type: 'invoice' | 'credit' | 'payment'
  /** Invoice number (INV-2026-00123) for invoices/credits,
   *  payment reference (e.g. "Bankeinzug 2026-06-15") for payments. */
  reference: string
  description: string
  /** Gross amount in EUR. Positive for invoices, negative for
   *  credits and payments (both reduce the open balance). */
  amount: number
  /** Running open balance AFTER this line. EUR. */
  balance: number
  /** Document id (invoice id or payment id) — used for
   *  "view invoice" links in the UI. */
  docId?: string
}

export interface CustomerStatement {
  customer: {
    id: string
    name: string
    customerNumber: string | null
    address: Record<string, any>
    vatId: string | null
  }
  period: { from: string; to: string }
  openingBalance: number
  lines: StatementLine[]
  closingBalance: number
  totals: {
    invoicesCount: number
    invoicesAmount: number
    paymentsCount: number
    paymentsAmount: number
    creditsCount: number
    creditsAmount: number
    /** Closing balance but formatted as a positive "offene Posten"
     *  amount (always >= 0). For a credit balance (customer paid
     *  too much) this is 0 and the actual credit is shown separately
     *  in the closingBalance field. */
    openAmount: number
  }
  generatedAt: string
}

@Injectable()
export class CustomerStatementService {
  constructor(private readonly prisma: PrismaService) {}

  /** Generate the JSON statement. */
  async generate(
    companyId: string,
    customerId: string,
    from: Date,
    to: Date,
  ): Promise<CustomerStatement> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: {
        id: true,
        name: true,
        customerNumber: true,
        address: true,
        vatId: true,
      },
    })
    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`)
    }

    // ── Opening balance ────────────────────────────────
    // Sum of all invoices issued BEFORE 'from' (positive)
    // minus sum of all payments received BEFORE 'from'
    // (regardless of which invoice the payment covered — for
    //  Kontoauszug purposes, payments reduce the open balance
    //  in date order, not by invoice allocation).
    const [invBefore, payBefore] = await Promise.all([
      this.prisma.invoice.aggregate({
        where: {
          customerId,
          companyId,
          // Exclude draft invoices — they haven't been sent yet
          // and shouldn't appear on the statement.
          status: { not: 'draft' },
          issueDate: { lt: from },
        },
        _sum: { total: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          invoice: { customerId, companyId },
          paymentDate: { lt: from },
        },
        _sum: { amount: true },
      }),
    ])
    const openingBalance =
      Number(invBefore._sum.total ?? 0) - Number(payBefore._sum.amount ?? 0)

    // ── Lines in [from..to] ───────────────────────────
    // Fetch invoices + payments in parallel, then merge
    // and sort by date ascending.
    const [invoices, payments] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          customerId,
          companyId,
          status: { not: 'draft' },
          issueDate: { gte: from, lte: to },
        },
        select: {
          id: true,
          invoiceNumber: true,
          issueDate: true,
          total: true,
          type: true,
        },
        orderBy: { issueDate: 'asc' },
      }),
      this.prisma.payment.findMany({
        where: {
          invoice: { customerId, companyId },
          paymentDate: { gte: from, lte: to },
        },
        select: {
          id: true,
          amount: true,
          currency: true,
          paymentDate: true,
          paymentMethod: true,
          reference: true,
          receiptNumber: true,
          invoice: {
            select: { invoiceNumber: true },
          },
        },
        orderBy: { paymentDate: 'asc' },
      }),
    ])

    // Build a unified timeline. We keep invoices and credits
    // (CN) separate because they have different semantics on
    // the PDF ("Rechnung" vs "Gutschrift").
    const lines: StatementLine[] = []

    for (const inv of invoices) {
      const isCredit = inv.type === 'CN' || inv.type === 'credit'
      // invoice.total for CN is ALREADY negative (set by
      // invoice.service.ts at create time). Don't negate it
      // again — that would flip a CN into a positive "invoice".
      lines.push({
        date: inv.issueDate.toISOString(),
        type: isCredit ? 'credit' : 'invoice',
        reference: inv.invoiceNumber,
        description: isCredit
          ? 'Gutschrift'
          : 'Rechnung',
        amount: Number(inv.total),
        balance: 0, // filled in below
        docId: inv.id,
      })
    }

    for (const p of payments) {
      lines.push({
        date: p.paymentDate.toISOString(),
        type: 'payment',
        reference: p.receiptNumber || p.reference || p.invoice.invoiceNumber,
        description: `Zahlung (${p.paymentMethod})`,
        amount: -Math.abs(Number(p.amount)),
        balance: 0,
        docId: p.id,
      })
    }

    // Stable sort by date ascending. For same-day entries,
    // invoices come before payments (matches bookkeeping
    // convention: write the receivable first, then the
    // receipt against it).
    lines.sort((a, b) => {
      const ad = new Date(a.date).getTime()
      const bd = new Date(b.date).getTime()
      if (ad !== bd) return ad - bd
      // Tiebreaker: payment comes after invoice on the
      // same day. We use type string order:
      //   credit < invoice < payment
      return a.type.localeCompare(b.type)
    })

    // Apply running balance
    let running = openingBalance
    let invoicesCount = 0
    let invoicesAmount = 0
    let paymentsCount = 0
    let paymentsAmount = 0
    let creditsCount = 0
    let creditsAmount = 0

    for (const line of lines) {
      running += line.amount
      line.balance = running
      if (line.type === 'invoice') {
        invoicesCount++
        invoicesAmount += line.amount
      } else if (line.type === 'credit') {
        creditsCount++
        creditsAmount += line.amount  // negative
      } else {
        paymentsCount++
        paymentsAmount += line.amount  // negative
      }
    }

    const closingBalance = running
    const openAmount = Math.max(0, closingBalance)

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        customerNumber: customer.customerNumber,
        address: customer.address as Record<string, any>,
        vatId: customer.vatId,
      },
      period: { from: from.toISOString(), to: to.toISOString() },
      openingBalance,
      lines,
      closingBalance,
      totals: {
        invoicesCount,
        invoicesAmount,
        paymentsCount,
        paymentsAmount,
        creditsCount,
        creditsAmount,
        openAmount,
      },
      generatedAt: new Date().toISOString(),
    }
  }
}