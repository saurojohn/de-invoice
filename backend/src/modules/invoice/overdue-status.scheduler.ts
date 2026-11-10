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
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../../prisma/prisma.service'
import { CronHealthService } from '../admin/cron-health.service'
import { businessTodayDate } from '../../common/business-date'
import { CLAIM_TYPES } from './document-scope'
import { invoicesHeldByPlan } from '../reminder/installment-hold'

@Injectable()
export class OverdueStatusScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(OverdueStatusScheduler.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly health: CronHealthService,
  ) {}

  /**
   * Tier 829 — once a minute after the server starts too (production only).
   * Measured on the production images: invoices entered on the first day
   * whose due date had passed („8 Tage überfällig" on the invoice page, 3
   * overdue on the customer's) stood as „Versendet" until the night — the
   * dashboard said „Überfällige Rechnungen 0 ✓". After a restart the same.
   * Not in the test suites (they start a server on a database of earlier
   * runs and read the statuses they set).
   */
  onApplicationBootstrap() {
    if (process.env.NODE_ENV !== 'production' || process.env.DISABLE_CRON === '1') return
    const timer = setTimeout(() => {
      void this.health.wrap('invoice-overdue-status', async () => this.run()).catch((e) =>
        this.logger.warn(`invoice-overdue-status at start: ${(e as Error).message}`))
    }, 60_000)
    timer.unref?.()
  }

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
        company: { closedAt: null }, // Tier 737
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
