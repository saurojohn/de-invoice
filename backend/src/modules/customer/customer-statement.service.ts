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
import { Prisma } from '@prisma/client'
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

export interface RatenplanLine {
  /** Ratenplan row id. The frontend uses this to
   *  open the Ratenplan modal on the invoice detail. */
  planId: string
  /** Invoice this Ratenplan is attached to. */
  invoiceId: string
  invoiceNumber: string
  /** Sum of all open Raten (status=open|partial|overdue) in EUR. */
  openAmount: number
  /** The next 3 Raten (or fewer if the plan has <3 left),
   *  sorted by dueDate asc. */
  upcoming: Array<{
    installmentId: string
    sequenceNumber: number
    dueDate: string
    amount: number
    paidAmount: number
    status: 'open' | 'partial' | 'overdue' | 'paid' | 'cancelled'
  }>
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
  /** Tier 58: customer's current credit balance
   *  (Kundenguthaben) — positive = customer is owed
   *  money (e.g. overpaid an invoice, Gutschrift
   *  overage, manual credit). Drawn from the
   *  CustomerCreditTransaction ledger. Currency
   *  is implicit EUR (the only currency the ledger
   *  supports today; future multi-currency would
   *  add `creditBalanceCurrency` here). */
  creditBalance: number
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
    /** Tier 56: number of overdue Raten across all
     *  active Ratenpläne. Drives the "next 3 Raten
     *  due" hint on the statement. */
    overdueRatenCount: number
    /** Tier 56: total sum of Skonto taken in the
     *  period (sum of (invoice.total - payment.amount)
     *  for Skonto invoices where the payment landed
     *  inside the Skonto window). Positive number
     *  representing the total discount granted. */
    skontoTakenAmount: number
  }
  /** Tier 56: per-invoice Ratenplan schedule. Only
   *  invoices with an ACTIVE Ratenplan (status='active')
   *  are listed. The customer can see at a glance
   *  "what's the next 3 Raten I owe on invoice
   *  X". Sorted by total openAmount desc — the
   *  biggest Ratenplan is at the top. */
  ratenplanSchedule: RatenplanLine[]
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
    order: 'asc' | 'desc' = 'desc',
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

    // Compute running balance CHRONOLOGICALLY first. The balance
    // field on each line represents "what the open balance was
    // AFTER this line was posted", which is a chronological
    // property — it doesn't change with display order.
    //
    // We therefore walk the lines in ASC order to assign
    // balances, then re-sort for display. This way:
    //   - DESC display shows the latest activity at top, each
    //     row still carrying its true historical balance
    //   - ASC display matches the paper-ledger convention
    //   - In both cases the bottom-row balance === closingBalance
    //     (when viewing ASC) OR the top-row balance === closingBalance
    //     (when viewing DESC) — same number, different position.
    let running = openingBalance
    let invoicesCount = 0
    let invoicesAmount = 0
    let paymentsCount = 0
    let paymentsAmount = 0
    let creditsCount = 0
    let creditsAmount = 0

    // Pre-sort by date asc + tiebreaker so balance assignment
    // is deterministic regardless of invoice/payment insert order.
    const byChronoAsc = (a: StatementLine, b: StatementLine) => {
      const ad = new Date(a.date).getTime()
      const bd = new Date(b.date).getTime()
      if (ad !== bd) return ad - bd
      return a.type.localeCompare(b.type)  // credit < invoice < payment
    }
    const sortedForBalance = [...lines].sort(byChronoAsc)
    for (const line of sortedForBalance) {
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

    // ── Tier 56: Skonto taken in the period ──────
    // We sum (invoice.total - payment.amount) for every
    // Skonto invoice (skontoPercent != null) where the
    // payment landed inside the period. The diff is
    // the Skonto taken. A payment that's larger than
    // the invoice total can't happen (the service
    // caps the amount at invoice.total), so the diff
    // is always >= 0.
    //
    // We deliberately skip the "Skonto taken" math
    // for partial payments (where the customer paid
    // a smaller amount but AFTER the Skonto window)
    // — those aren't Skonto, they're normal partials.
    // The check is "the payment was on a Skonto
    // invoice AND the payment date is within the
    // Skonto window". Computing that window requires
    // knowing the invoice's issueDate + skontoDays
    // which we have in `invoices` above.
    let skontoTakenAmount = 0
    {
      // Build a quick lookup: invoiceId -> {issueDate, skontoDays, total}.
      const invLookup = new Map<
        string,
        { issueDate: Date; skontoDays: number | null; total: number }
      >()
      for (const inv of invoices) {
        // Re-fetch the full row to get skontoDays
        // (the lightweight `select` above skipped it).
        // In practice the customer statement service
        // is called for a single customer so the
        // N+1 cost is small; if it ever grows we
        // can promote skontoDays to the same select.
        const full = await this.prisma.invoice.findUnique({
          where: { id: inv.id },
          select: { issueDate: true, skontoDays: true, total: true },
        })
        if (!full) continue
        invLookup.set(inv.id, {
          issueDate: full.issueDate,
          skontoDays: full.skontoDays,
          total: Number(full.total),
        })
      }
      // For each payment against a Skonto invoice,
      // check the Skonto window: paymentDate must be
      // <= issueDate + skontoDays.
      for (const p of payments) {
        // The Payment row carries invoiceId via the
        // join we already loaded (p.invoice). We need
        // invoiceId to look up the Skonto window.
        // Add a tiny extra select if missing — but
        // the join in the existing query selects
        // only `invoice.invoiceNumber`, not the FK.
        // Re-fetch the payment row to get the FK.
        const paymentFull = await this.prisma.payment.findUnique({
          where: { id: p.id },
          select: { invoiceId: true },
        })
        if (!paymentFull) continue
        const invMeta = invLookup.get(paymentFull.invoiceId)
        if (!invMeta || invMeta.skontoDays == null) continue
        const skontoExpiry = new Date(invMeta.issueDate)
        skontoExpiry.setDate(
          skontoExpiry.getDate() + invMeta.skontoDays,
        )
        skontoExpiry.setHours(23, 59, 59, 999)
        if (new Date(p.paymentDate) > skontoExpiry) continue
        // Skonto taken = invoice.total - payment.amount
        // (always >= 0; both positive). We use the
        // invoice's ORIGINAL gross total — a payment
        // smaller than the gross total means the
        // customer got a Skonto discount.
        const skonto = invMeta.total - Math.abs(Number(p.amount))
        if (skonto > 0.005) {
          skontoTakenAmount += skonto
        }
      }
    }

    // ── Tier 56: Ratenplan schedule for open invoices ──
    // We list every ACTIVE Ratenplan attached to one
    // of the customer's invoices, with the next 3
    // Raten (by dueDate asc) per plan. Sorted by
    // total openAmount desc — biggest Ratenplan first.
    const ratenplanSchedule: RatenplanLine[] = []
    let overdueRatenCount = 0
    {
      const plans = await this.prisma.installmentPlan.findMany({
        where: {
          companyId,
          customerId,
          status: 'active',
        },
        include: {
          invoice: {
            select: { id: true, invoiceNumber: true },
          },
          installments: {
            orderBy: { dueDate: 'asc' },
          },
        },
      })
      for (const plan of plans) {
        // Sum the open Raten (status NOT in
        // ['paid','cancelled']). 'overdue' counts.
        const openInst = plan.installments.filter(
          (i) => i.status !== 'paid' && i.status !== 'cancelled',
        )
        if (openInst.length === 0) continue
        const openAmount = openInst.reduce(
          (s, i) => s
            .plus(i.amount ?? new Prisma.Decimal(0))
            .minus(i.paidAmount ?? new Prisma.Decimal(0)),
          new Prisma.Decimal(0),
        ).toNumber()
        // Count how many are overdue.
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        for (const i of openInst) {
          if (i.status === 'overdue' || (i.status === 'open' && new Date(i.dueDate) < today)) {
            overdueRatenCount++
          }
        }
        // The next 3 Raten — already sorted by dueDate asc.
        const upcoming = openInst.slice(0, 3).map((i) => ({
          installmentId: i.id,
          sequenceNumber: i.sequenceNumber,
          dueDate: new Date(i.dueDate).toISOString(),
          amount: Number(i.amount),
          paidAmount: Number(i.paidAmount),
          status: i.status as RatenplanLine['upcoming'][number]['status'],
        }))
        ratenplanSchedule.push({
          planId: plan.id,
          invoiceId: plan.invoice.id,
          invoiceNumber: plan.invoice.invoiceNumber,
          openAmount,
          upcoming,
        })
      }
      // Sort by openAmount desc.
      ratenplanSchedule.sort((a, b) => b.openAmount - a.openAmount)
    }

    // Now apply the user-requested display order. Balances are
    // already attached to each line — sorting doesn't recompute
    // them, just reorders.
    lines.sort((a, b) => {
      const ad = new Date(a.date).getTime()
      const bd = new Date(b.date).getTime()
      if (ad !== bd) {
        return order === 'asc' ? ad - bd : bd - ad
      }
      const cmp = a.type.localeCompare(b.type)
      return order === 'asc' ? cmp : -cmp
    })

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
      // Tier 58: pull the current credit balance from the
      // CustomerCreditTransaction ledger. Same value as
      // GET /customers/:id/credit-balance, but co-located
      // on the statement so the customer detail page can
      // render a single "Guthaben" badge without an extra
      // round-trip. Computed in the same generate() pass
      // — the aggregate is a single index-backed SUM.
      creditBalance: await this.getCreditBalance(companyId, customer.id),
      totals: {
        invoicesCount,
        invoicesAmount,
        paymentsCount,
        paymentsAmount,
        creditsCount,
        creditsAmount,
        openAmount,
        overdueRatenCount,
        skontoTakenAmount,
      },
      ratenplanSchedule,
      generatedAt: new Date().toISOString(),
    }
  }

  /**
   * Tier 58: current credit balance (Kundenguthaben) for a
   * customer. SUM(amount) over the CustomerCreditTransaction
   * ledger — same query CreditBalanceService.getCreditBalance
   * runs, but inlined here so the statement generate() pass
   * avoids an extra service call.
   *
   * The aggregate is index-backed (`companyId, customerId`
   * composite index + `customerId, createdAt`). Even with
   * thousands of ledger rows the query stays sub-millisecond.
   */
  private async getCreditBalance(
    companyId: string,
    customerId: string,
  ): Promise<number> {
    const sum = await this.prisma.customerCreditTransaction.aggregate({
      where: { companyId, customerId },
      _sum: { amount: true },
    })
    return Number(sum._sum.amount ?? 0)
  }
}