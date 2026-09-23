/**
 * Tier 429 — the Raten of a Ratenplan follow the invoice's payments.
 *
 * The invoice's payments are the truth; the installments are a view of them.
 * Every payment recorded on the invoice after the plan was set up (by the
 * "Rate bezahlt" button, the bank import, a manual payment or a credit note)
 * is spread over the Raten in order, and the plan completes when they are all
 * covered.
 *
 * Measured before: paying a Rate only raised that Rate's `paidAmount`. The
 * invoice got no payment — it stayed "sent" after the plan "completed", the
 * UStVA, DATEV, the balance sheet and the ageing never saw the money — and a
 * payment booked on the invoice by the bank import left the Raten open and
 * overdue. An overpayment of a Rate was silently cut off at its amount.
 */
import { PrismaClient, Prisma } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100)

/**
 * Recompute the Raten of the invoice's plan (if it has an active or completed
 * one) from the payments recorded since the plan was created.
 */
export async function syncInstallments(db: Db, invoiceId: string, now: Date = new Date()): Promise<void> {
  const plan = await db.installmentPlan.findFirst({
    where: { invoiceId, status: { in: ['active', 'completed'] } },
    include: { installments: { orderBy: { sequenceNumber: 'asc' } } },
  })
  if (!plan) return

  const payments = await db.payment.findMany({
    where: { invoiceId, createdAt: { gte: plan.createdAt } },
    select: { amount: true, paymentDate: true },
    orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
  })
  let available = payments.reduce((s, p) => s + cents(p.amount), 0)
  const lastPaymentDate = payments.length ? payments[payments.length - 1].paymentDate : null

  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  let allPaid = true
  for (const inst of plan.installments) {
    if (inst.status === 'cancelled') continue
    const amount = cents(inst.amount)
    const paid = Math.max(0, Math.min(amount, available))
    available -= paid
    const status =
      paid >= amount ? 'paid'
      : inst.dueDate < today ? 'overdue'
      : paid > 0 ? 'partial'
      : 'open'
    if (status !== 'paid') allPaid = false
    if (paid !== cents(inst.paidAmount) || status !== inst.status) {
      await db.installment.update({
        where: { id: inst.id },
        data: {
          paidAmount: paid / 100,
          status,
          paidAt: status === 'paid' ? (inst.paidAt ?? lastPaymentDate ?? now) : null,
        },
      })
    }
  }

  const planStatus = allPaid ? 'completed' : 'active'
  if (planStatus !== plan.status) {
    await db.installmentPlan.update({ where: { id: plan.id }, data: { status: planStatus } })
  }
  if (allPaid) await endPlanPause(db, plan.companyId, invoiceId, plan.createdAt, now)
}

/**
 * End the dunning pause the plan set for its invoice: the invoice-level pause
 * created with the plan (its reason is configurable, so it is recognised by
 * invoice and time, not by text). A pause the user set earlier is kept.
 */
export async function endPlanPause(
  db: Db,
  companyId: string,
  invoiceId: string,
  planCreatedAt: Date,
  now: Date = new Date(),
) {
  await db.mahnungspause.updateMany({
    where: {
      companyId,
      invoiceId,
      createdAt: { gte: planCreatedAt },
      cancelledAt: null,
      OR: [{ pausedUntil: null }, { pausedUntil: { gt: now } }],
    },
    data: { pausedUntil: now },
  })
}
