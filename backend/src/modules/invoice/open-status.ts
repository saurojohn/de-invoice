/**
 * Tier 711 — the status of an issued invoice on which money is open.
 *
 * „überfällig“ past its due date, „versendet“ before it — and „versendet“
 * while an installment plan holds it (a Stundung: the Raten are its due
 * dates, § 286 BGB; reminder/installment-hold.ts). The nightly job (Tier 710)
 * marks what became overdue overnight; this puts an invoice right at once
 * when something else changes it: a payment removed (it went back to
 * „versendet“ although long past due), a plan agreed (it stayed
 * „überfällig“ under the plan), a plan cancelled.
 */
import { businessTodayDate } from '../../common/business-date'
import { invoicesHeldByPlan } from '../reminder/installment-hold'
import { CLAIM_TYPES } from './document-scope'

export async function refreshOpenStatus(prisma: any, companyId: string, invoiceId: string): Promise<void> {
  const inv: { status: string; type: string; dueDate: Date | null; total: unknown; payments: { amount: unknown }[] } | null =
    await prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { status: true, type: true, dueDate: true, total: true, payments: { select: { amount: true } } },
    })
  if (!inv || !CLAIM_TYPES.includes(inv.type) || !['sent', 'overdue'].includes(inv.status)) return
  const open = Math.round(Number(inv.total) * 100) - inv.payments.reduce((s, p) => s + Math.round(Number(p.amount ?? 0) * 100), 0)
  if (open <= 0) return
  const pastDue = !!inv.dueDate && new Date(inv.dueDate) < businessTodayDate()
  const status = pastDue && !(await invoicesHeldByPlan(prisma, companyId, [invoiceId])).has(invoiceId) ? 'overdue' : 'sent'
  if (status !== inv.status) {
    await prisma.invoice.updateMany({ where: { id: invoiceId, companyId, status: inv.status }, data: { status } })
  }
}
