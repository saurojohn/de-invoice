/**
 * Tier 430 — payments reported by the customer (Zahlungsavis).
 *
 * The customer portal's "als bezahlt markieren" and the payment link's
 * "bezahlt" button used to book a Payment and set the invoice to paid on the
 * customer's word — for any amount they typed. A report is not a receipt:
 * it is recorded here, and the company books it as a real payment (through
 * PaymentService, like any other) once the money has arrived, or dismisses it.
 */
import { BadRequestException } from '@nestjs/common'
import { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100)

/**
 * Record a reported payment. The amount defaults to what is still open and
 * may not exceed it; one open report per invoice (a second click returns it).
 */
export async function recordPaymentNotice(
  db: Db,
  args: {
    companyId: string
    invoice: { id: string; total: unknown; payments: { amount: unknown }[] }
    amount?: number
    source: 'customer-portal' | 'payment-link'
    note?: string
  },
) {
  const existing = await db.paymentNotice.findFirst({
    where: { invoiceId: args.invoice.id, status: 'open' },
  })
  if (existing) return existing

  const openCents = cents(args.invoice.total) - args.invoice.payments.reduce((s, p) => s + cents(p.amount), 0)
  if (openCents <= 0) {
    throw new BadRequestException('Die Rechnung ist bereits vollständig bezahlt')
  }
  const reportedCents = args.amount === undefined ? openCents : Math.round(Number(args.amount) * 100)
  if (!Number.isFinite(reportedCents) || reportedCents <= 0) {
    throw new BadRequestException('Betrag muss größer als 0 sein')
  }
  if (reportedCents > openCents) {
    throw new BadRequestException(
      `Der gemeldete Betrag übersteigt den offenen Betrag der Rechnung (${(openCents / 100).toFixed(2)})`,
    )
  }
  return db.paymentNotice.create({
    data: {
      companyId: args.companyId,
      invoiceId: args.invoice.id,
      amount: (reportedCents / 100).toFixed(2),
      source: args.source,
      note: args.note ?? null,
    },
  })
}
