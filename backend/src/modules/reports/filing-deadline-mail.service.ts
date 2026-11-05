import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { AuditService } from '../audit/audit.service'
import { updateCompanySettings } from '../../common/company-settings'
import { publicOrigin } from '../../common/public-origin'
import { FilingDeadlinesService, type FilingDeadline } from './filing-deadlines.service'
import { dueReminders } from './filing-deadlines'

/**
 * Tier 803 — a mail to the company's admins seven and two days before a
 * return is due (the rows of GET /ustva/deadlines that are open). One mail
 * per company and day with every row that reached a stage; a stage is sent
 * once (settings.fristErinnerungGesendet). Off with
 * settings.fristErinnerungMail = false (the UStVA page).
 */
const KIND = { ustva: 'UStVA', zm: 'ZM', oss: 'OSS', annual: 'Jahreserklärungen', svz: 'Sondervorauszahlung', dauerfrist: 'Dauerfristverlängerung',
  // Tier 804
  kst: 'Körperschaftsteuer-Vorauszahlung', gewst: 'Gewerbesteuer-Vorauszahlung' } as const
/** keys kept — a year of reminders and more */
const KEEP = 120

const dmy = (iso: string) => iso.split('-').reverse().join('.')
const eur = (n: number) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
const label = (r: FilingDeadline) => {
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
  const period = r.month ? `${MONTHS[r.month - 1]} ${r.year}` : r.quarter ? `Q${r.quarter} ${r.year}` : String(r.year)
  return `${KIND[r.kind]} ${period}`
}

export interface ReminderRun {
  companyId: string
  sent: boolean
  skipped?: 'disabled' | 'nothing-due' | 'no-recipient'
  items: Array<{ kind: string; year: number; month: number | null; quarter: number | null; dueDate: string; daysLeft: number; stage: number }>
  recipients: number
  error?: string
}

@Injectable()
export class FilingDeadlineMailService {
  private readonly logger = new Logger(FilingDeadlineMailService.name)

  constructor(
    private prisma: PrismaService,
    private deadlines: FilingDeadlinesService,
    private mail: MailService,
    private audit: AuditService,
  ) {}

  async remindCompany(companyId: string): Promise<ReminderRun> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true, settings: true } })
    const s = (company?.settings ?? {}) as Record<string, unknown>
    if (s.fristErinnerungMail === false) return { companyId, sent: false, skipped: 'disabled', items: [], recipients: 0 }
    const sentKeys = new Set(Array.isArray(s.fristErinnerungGesendet) ? (s.fristErinnerungGesendet as string[]) : [])
    const { deadlines } = await this.deadlines.deadlines(companyId)
    const due = dueReminders(deadlines, sentKeys)
    const items = due.map(({ row, stage }) => ({ kind: row.kind, year: row.year, month: row.month, quarter: row.quarter, dueDate: row.dueDate, daysLeft: row.daysLeft, stage }))
    if (due.length === 0) return { companyId, sent: false, skipped: 'nothing-due', items, recipients: 0 }

    const admins = await this.prisma.userCompany.findMany({
      where: { companyId, role: 'admin', user: { status: 'active' } },
      select: { user: { select: { email: true } } },
    })
    const to = [...new Set(admins.map((a) => a.user.email).filter(Boolean))]
    if (to.length === 0) return { companyId, sent: false, skipped: 'no-recipient', items, recipients: 0 }

    const first = due[0].row
    const subject = due.length === 1
      ? `Frist: ${label(first)} — fällig am ${dmy(first.dueDate)}`
      : `Fristen: ${due.length} Termine fällig, der erste am ${dmy(first.dueDate)}`
    const lines = due.map(({ row }) => {
      const when = row.daysLeft === 0 ? 'heute' : row.daysLeft === 1 ? 'morgen' : `in ${row.daysLeft} Tagen`
      // Tier 804: a prepayment's amount is the Bescheid's; only the Sondervorauszahlung is estimated
      const amount = row.amount ? ` (${row.kind === 'svz' ? 'ca. ' : ''}${eur(row.amount)})` : ''
      return `• ${label(row)}${amount}: fällig am ${dmy(row.dueDate)} — ${when}${row.note ? `\n  ${row.note}` : ''}`
    })
    const text =
      `Guten Tag,\n\nfür ${company?.name ?? 'Ihre Firma'} stehen diese Abgabe- und Zahlungsfristen an:\n\n${lines.join('\n')}\n\n` +
      `Fällt eine Frist auf ein Wochenende oder einen Feiertag, endet sie am nächsten Werktag (§ 108 Abs. 3 AO) — ` +
      `außer der OSS-Frist; die Daten oben sind schon verschoben.\n\nÜbersicht: ${publicOrigin()}/dashboard\n\n` +
      `Diese Erinnerung lässt sich unter Umsatzsteuer → „Voranmeldungszeitraum laut Finanzamt“ abschalten.\n`

    try {
      for (const addr of to) await this.mail.send(companyId, { to: addr, subject, text })
    } catch (e: any) {
      // not marked as sent: the next run tries again
      this.logger.warn(`[frist-mail] company ${companyId}: ${e?.message || e}`)
      return { companyId, sent: false, items, recipients: to.length, error: String(e?.message || e) }
    }
    await updateCompanySettings(this.prisma, companyId, (next) => {
      const prev = Array.isArray(next.fristErinnerungGesendet) ? (next.fristErinnerungGesendet as string[]) : []
      next.fristErinnerungGesendet = [...prev, ...due.flatMap((d) => d.keys)].slice(-KEEP)
    })
    await this.audit.writeActivity({
      companyId,
      userId: null,
      action: 'filing_deadlines.reminder_sent',
      entityType: 'Company',
      entityId: companyId,
      metadata: { items, recipients: to.length },
      ipAddress: null,
      userAgent: 'de-invoice:filing-deadline-reminders',
    })
    return { companyId, sent: true, items, recipients: to.length }
  }

  /** Every open company; one company's failure does not stop the others. */
  async remindAll(): Promise<{ companies: number; sent: number; errors: number }> {
    const companies = await this.prisma.company.findMany({ where: { closedAt: null }, select: { id: true } })
    let sent = 0
    let errors = 0
    for (const c of companies) {
      try {
        const r = await this.remindCompany(c.id)
        if (r.sent) sent++
        if (r.error) errors++
      } catch (e: any) {
        errors++
        this.logger.warn(`[frist-mail] company ${c.id}: ${e?.message || e}`)
      }
    }
    return { companies: companies.length, sent, errors }
  }
}
