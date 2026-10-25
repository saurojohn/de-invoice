/**
 * Tier 710 — an invoice past its due date is „überfällig“.
 *
 * The status `overdue` exists, and the invoice list's filter chip
 * („Überfällig“), the dashboard's tile „Überfällige Rechnungen“, the
 * customer report's overdue column and the customer page read it — but
 * nothing set it: only a user choosing it by hand in the status dropdown.
 * Measured: invoices of 2025 and January, unpaid, all „Versendet“; the
 * dashboard said „0 überfällige Rechnungen“.
 *
 * Every night at 00:05 (German time) an issued invoice or receipt whose due
 * date has passed and on which money is open becomes `overdue` — unless an
 * installment plan holds it (the Raten are its due dates then; the reminders
 * keep the same rule, reminder/installment-hold.ts). A payment that settles
 * it makes it „bezahlt“ as before.
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../../prisma/prisma.service'
import { CronHealthService } from '../admin/cron-health.service'
import { businessTodayDate } from '../../common/business-date'
import { CLAIM_TYPES } from './document-scope'
import { invoicesHeldByPlan } from '../reminder/installment-hold'

@Injectable()
export class OverdueStatusScheduler {
  private readonly logger = new Logger(OverdueStatusScheduler.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly health: CronHealthService,
  ) {}

  @Cron('5 0 * * *', {
    name: 'invoice-overdue-status',
    timeZone: 'Europe/Berlin',
  })
  async nightly() {
    if (process.env.DISABLE_CRON === '1') {
      this.logger.debug('Skipping (DISABLE_CRON=1)')
      return
    }
    return this.health.wrap('invoice-overdue-status', async () => this.run())
  }

  /** The body — for one company or all; the e2e spec calls it through a test-only route. */
  async run(companyId?: string): Promise<{ marked: number }> {
    const today = businessTodayDate()
    const due = await this.prisma.invoice.findMany({
      where: {
        ...(companyId ? { companyId } : {}),
        status: 'sent',
        type: { in: CLAIM_TYPES },
        dueDate: { lt: today },
      },
      select: { id: true, companyId: true, total: true, payments: { select: { amount: true } } },
    })
    const byCompany = new Map<string, typeof due>()
    for (const inv of due) {
      const open = Math.round(Number(inv.total) * 100) - inv.payments.reduce((s, p) => s + Math.round(Number(p.amount ?? 0) * 100), 0)
      if (open <= 0) continue
      const list = byCompany.get(inv.companyId)
      if (list) list.push(inv)
      else byCompany.set(inv.companyId, [inv])
    }
    let marked = 0
    for (const [cid, rows] of byCompany) {
      const held = await invoicesHeldByPlan(this.prisma, cid, rows.map((r) => r.id))
      const ids = rows.map((r) => r.id).filter((id) => !held.has(id))
      if (!ids.length) continue
      const { count } = await this.prisma.invoice.updateMany({
        where: { id: { in: ids }, companyId: cid, status: 'sent' },
        data: { status: 'overdue' },
      })
      marked += count
    }
    if (marked) this.logger.log(`invoice-overdue-status: ${marked} invoice(s) past their due date marked overdue`)
    return { marked }
  }
}
