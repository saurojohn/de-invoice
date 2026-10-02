import { businessTodayDate } from '../../common/business-date'

/**
 * Tier 500 — an invoice under an installment plan is not dunned while the
 * plan is kept.
 *
 * A Ratenplan is a Stundung: as long as no installment is late, the customer
 * is not in Verzug for the invoice (§ 286 BGB). Measured: a manual reminder
 * for the full amount went out for such an invoice, and once an installment
 * was late the plan's open-ended Mahnungspause kept the invoice from being
 * dunned at all.
 *
 * Returns the invoices with an active plan and no overdue installment
 * (unpaid, due before today). A plan with an overdue installment is broken:
 * the invoice is dunned again (its pause is not counted either, see
 * MahnungspauseService).
 */
export async function invoicesHeldByPlan(prisma: any, companyId: string, invoiceIds: string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set()
  const today = businessTodayDate()
  const plans: Array<{ invoiceId: string; installments: Array<{ dueDate: Date; status: string }> }> =
    await prisma.installmentPlan.findMany({
      where: { companyId, status: 'active', invoiceId: { in: invoiceIds } },
      select: { invoiceId: true, installments: { select: { dueDate: true, status: true } } },
    })
  const held = new Set<string>()
  for (const p of plans) {
    const broken = p.installments.some(
      (i) => !['paid', 'cancelled'].includes(i.status) && new Date(i.dueDate) < today,
    )
    if (!broken) held.add(p.invoiceId)
  }
  return held
}

export const PLAN_HOLD_MESSAGE =
  'Für diese Rechnung läuft ein Ratenplan und keine Rate ist überfällig — sie wird nicht gemahnt.'
