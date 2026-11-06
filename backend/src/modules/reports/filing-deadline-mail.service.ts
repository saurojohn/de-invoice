import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { AuditService } from '../audit/audit.service'
import { updateCompanySettings } from '../../common/company-settings'
import { publicOrigin } from '../../common/public-origin'
import { FilingDeadlinesService, type FilingDeadline } from './filing-deadlines.service'
import { createHash } from 'crypto'
import { deadlineLabel, dueReminders } from './filing-deadlines'

/**
 * Tier 803 — a mail to the company's admins seven and two days before a
 * return is due (the rows of GET /ustva/deadlines that are open). One mail
 * per admin and day with every row that reached a stage; a stage is sent
 * once (settings.fristErinnerungGesendet). Off with
 * settings.fristErinnerungMail = false (the UStVA page).
 *
 * Tier 806:
 *  - what was sent is kept per admin (`<key>><recipient>`, the recipient a
 *    hash of the address): one admin's address refused no longer sends the
 *    others the same mail again every morning;
 *  - the stages are claimed under the company's settings lock before the
 *    mails go out, so two runs at once (the 07:00 job and POST
 *    /ustva/deadlines/remind) cannot both send; a claim whose mail failed is
 *    given back, the next run tries that admin again;
 *  - the key carries the due day (filing-deadlines.ts reminderKey).
 */
/** entries kept — a year of reminders for a few admins */
const KEEP = 600

const dmy = (iso: string) => iso.split('-').reverse().join('.')
const eur = (n: number) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
const recipientId = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)

type Due = ReturnType<typeof dueReminders<FilingDeadline>>

export interface ReminderRun {
  companyId: string
  sent: boolean
  skipped?: 'disabled' | 'nothing-due' | 'no-recipient'
  items: Array<{ kind: string; year: number; month: number | null; quarter: number | null; dueDate: string; daysLeft: number; stage: number }>
  /** the admins mailed in this run */
  recipients: number
  /** Tier 806: the admins whose mail failed (tried again next run) */
  failed?: number
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

  private compose(companyName: string | null | undefined, due: Due) {
    const first = due[0].row
    const subject = due.length === 1
      ? `Frist: ${deadlineLabel(first)} — fällig am ${dmy(first.dueDate)}`
      : `Fristen: ${due.length} Termine fällig, der erste am ${dmy(first.dueDate)}`
    const lines = due.map(({ row }) => {
      const when = row.daysLeft === 0 ? 'heute' : row.daysLeft === 1 ? 'morgen' : `in ${row.daysLeft} Tagen`
      // Tier 804: a prepayment's amount is the Bescheid's; only the Sondervorauszahlung is estimated
      const amount = row.amount ? ` (${row.kind === 'svz' ? 'ca. ' : ''}${eur(row.amount)})` : ''
      return `• ${deadlineLabel(row)}${amount}: fällig am ${dmy(row.dueDate)} — ${when}${row.note ? `\n  ${row.note}` : ''}`
    })
    const text =
      `Guten Tag,\n\nfür ${companyName ?? 'Ihre Firma'} stehen diese Abgabe- und Zahlungsfristen an:\n\n${lines.join('\n')}\n\n` +
      `Fällt eine Frist auf ein Wochenende oder einen Feiertag, endet sie am nächsten Werktag (§ 108 Abs. 3 AO) — ` +
      `außer der OSS-Frist; die Daten oben sind schon verschoben.\n\nÜbersicht: ${publicOrigin()}/dashboard\n\n` +
      `Diese Erinnerung lässt sich unter Umsatzsteuer → „Voranmeldungszeitraum laut Finanzamt“ abschalten.\n`
    return { subject, text }
  }

  async remindCompany(companyId: string): Promise<ReminderRun> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true, settings: true } })
    const s = (company?.settings ?? {}) as Record<string, unknown>
    if (s.fristErinnerungMail === false) return { companyId, sent: false, skipped: 'disabled', items: [], recipients: 0 }
    const { deadlines } = await this.deadlines.deadlines(companyId)
    const admins = await this.prisma.userCompany.findMany({
      where: { companyId, role: 'admin', user: { status: 'active' } },
      select: { user: { select: { email: true } } },
    })
    const to = [...new Set(admins.map((a) => a.user.email).filter(Boolean))]
    if (to.length === 0) {
      const any = dueReminders(deadlines, new Set())
      return { companyId, sent: false, skipped: any.length ? 'no-recipient' : 'nothing-due', items: [], recipients: 0 }
    }

    // claim, under the lock, what each admin is to get now
    const claims = await updateCompanySettings(this.prisma, companyId, (next) => {
      const kept = Array.isArray(next.fristErinnerungGesendet) ? (next.fristErinnerungGesendet as string[]) : []
      const out: Array<{ addr: string; rid: string; due: Due; entries: string[] }> = []
      for (const addr of to) {
        const rid = recipientId(addr)
        const mine = new Set(kept.filter((k) => k.endsWith(`>${rid}`)).map((k) => k.slice(0, -(rid.length + 1))))
        const due = dueReminders(deadlines, mine)
        if (due.length) out.push({ addr, rid, due, entries: due.flatMap((d) => d.keys).map((k) => `${k}>${rid}`) })
      }
      if (out.length) next.fristErinnerungGesendet = [...kept, ...out.flatMap((c) => c.entries)].slice(-KEEP)
      return out
    })
    if (claims.length === 0) return { companyId, sent: false, skipped: 'nothing-due', items: [], recipients: 0 }

    const done: typeof claims = []
    const failed: Array<{ claim: (typeof claims)[number]; error: string }> = []
    for (const c of claims) {
      try {
        await this.mail.send(companyId, { to: c.addr, ...this.compose(company?.name, c.due) })
        done.push(c)
      } catch (e: any) {
        failed.push({ claim: c, error: String(e?.message || e) })
        this.logger.warn(`[frist-mail] company ${companyId}: ${e?.message || e}`)
      }
    }
    if (failed.length) {
      // given back: the next run tries these admins again
      const back = new Set(failed.flatMap((f) => f.claim.entries))
      await updateCompanySettings(this.prisma, companyId, (next) => {
        const kept = Array.isArray(next.fristErinnerungGesendet) ? (next.fristErinnerungGesendet as string[]) : []
        next.fristErinnerungGesendet = kept.filter((k) => !back.has(k))
      })
    }

    const seen = new Set<string>()
    const items: ReminderRun['items'] = []
    for (const c of done) {
      for (const { row, stage } of c.due) {
        const k = `${row.kind}:${row.year}:${row.month}:${row.quarter}:${stage}`
        if (seen.has(k)) continue
        seen.add(k)
        items.push({ kind: row.kind, year: row.year, month: row.month, quarter: row.quarter, dueDate: row.dueDate, daysLeft: row.daysLeft, stage })
      }
    }
    items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.kind.localeCompare(b.kind))
    if (done.length) {
      await this.audit.writeActivity({
        companyId,
        userId: null,
        action: 'filing_deadlines.reminder_sent',
        entityType: 'Company',
        entityId: companyId,
        metadata: { items, recipients: done.length, failed: failed.length },
        ipAddress: null,
        userAgent: 'de-invoice:filing-deadline-reminders',
      })
    }
    return {
      companyId,
      sent: done.length > 0,
      items,
      recipients: done.length,
      ...(failed.length ? { failed: failed.length, error: failed[0].error } : {}),
    }
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
