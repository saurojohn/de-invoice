import { Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes, timingSafeEqual } from 'crypto'
import { PrismaService } from '../../prisma/prisma.service'
import { tokenHash } from '../../common/token-hash'
import { updateCompanySettings } from '../../common/company-settings'
import { publicOrigin } from '../../common/public-origin'
import { UsersService } from '../users/users.service'
import { FilingDeadlinesService, NOTES, type FilingDeadline } from './filing-deadlines.service'
import {
  Period, addDaysIso, annualReturnDeadline, daysBetween, ossDeadline, periodContaining, periodEnd, periodName,
  prepaymentDeadline, sondervorauszahlungDeadline, ustvaDeadline, isoDay, type PrepaymentTax,
} from './filing-deadlines'
import { buildIcs } from './filing-calendar'

/**
 * Tier 805 — the deadlines as a calendar to subscribe to.
 *
 * A link with a random token (32 bytes) serves GET /calendar/<token>.ics
 * without a sign-in — a calendar app sends no credentials. The token is shown
 * once, when it is made; the company keeps only its hash
 * (settings.kalenderAbo, as the sessions do since Tier 785). A new link
 * replaces the old one; the link can be withdrawn. It is the link of the admin
 * who made it: it stops when that user is no longer active in the company or
 * may no longer change its settings, and when the company is closed.
 *
 * The feed holds the rows of the dashboard and what follows within a year:
 * the later UStVA (and OSS) periods, the prepayments entered for later
 * quarters, the annual returns of the running year, the next
 * Sondervorauszahlung.
 */
const HORIZON_DAYS = 366

interface KalenderAbo { tokenHash: string; createdAt: string; userId: string | null }

const isAbo = (v: unknown): v is KalenderAbo =>
  !!v && typeof v === 'object' && typeof (v as KalenderAbo).tokenHash === 'string' && /^[0-9a-f]{64}$/.test((v as KalenderAbo).tokenHash)

const nextPeriod = (p: Period): Period =>
  p.month
    ? p.month === 12 ? { year: p.year + 1, month: 1 } : { year: p.year, month: p.month + 1 }
    : p.quarter === 4 ? { year: p.year + 1, quarter: 1 } : { year: p.year, quarter: (p.quarter ?? 0) + 1 }

const key = (r: { kind: string; year: number; month: number | null; quarter: number | null }) =>
  `${r.kind}:${r.year}:${r.month ?? ''}:${r.quarter ?? ''}`

@Injectable()
export class FilingCalendarService {
  constructor(
    private prisma: PrismaService,
    private deadlines: FilingDeadlinesService,
  ) {}

  async status(companyId: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } })
    const abo = ((company?.settings ?? {}) as Record<string, unknown>).kalenderAbo
    if (!isAbo(abo)) return { active: false, createdAt: null, createdBy: null }
    const user = abo.userId
      ? await this.prisma.user.findUnique({ where: { id: abo.userId }, select: { email: true } })
      : null
    const name = user?.email ?? null
    return { active: true, createdAt: abo.createdAt, createdBy: name }
  }

  /** A new link; the one before stops working. The URL is in this answer only. */
  async create(companyId: string, userId: string | null, req?: any) {
    const token = randomBytes(32).toString('base64url')
    const abo: KalenderAbo = { tokenHash: tokenHash(token), createdAt: new Date().toISOString(), userId }
    const replaced = await updateCompanySettings(this.prisma, companyId, (s) => {
      const had = isAbo(s.kalenderAbo)
      s.kalenderAbo = abo
      return had
    })
    return { active: true, createdAt: abo.createdAt, replaced, url: `${publicOrigin(req)}/api/v1/calendar/${token}.ics` }
  }

  async revoke(companyId: string) {
    const had = await updateCompanySettings(this.prisma, companyId, (s) => {
      const was = isAbo(s.kalenderAbo)
      delete s.kalenderAbo
      return was
    })
    return { active: false, revoked: had }
  }

  /** The feed of a token, or 404 — the same answer for an unknown, withdrawn or no longer valid link. */
  async feed(rawToken: string): Promise<string> {
    const token = String(rawToken || '').replace(/\.ics$/i, '')
    const gone = () => new NotFoundException('Kalender-Link unbekannt oder nicht mehr gültig')
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw gone()
    const hash = tokenHash(token)
    const company = await this.prisma.company.findFirst({
      where: { settings: { path: ['kalenderAbo', 'tokenHash'], equals: hash }, closedAt: null },
      select: { id: true, name: true, settings: true },
    })
    const abo = ((company?.settings ?? {}) as Record<string, unknown>).kalenderAbo
    if (!company || !isAbo(abo) || !timingSafeEqual(Buffer.from(abo.tokenHash), Buffer.from(hash))) throw gone()
    // the admin who made the link must still be one
    if (!abo.userId) throw gone()
    const member = await this.prisma.userCompany.findFirst({
      where: { companyId: company.id, userId: abo.userId, user: { status: 'active' } },
      select: { role: true },
    })
    if (!member || !UsersService.can(member.role, 'company.update')) throw gone()

    const rows = await this.rows(company.id)
    return buildIcs(rows, { companyId: company.id, companyName: company.name, origin: publicOrigin(), now: new Date() })
  }

  /** The dashboard's rows, and what follows within a year. */
  async rows(companyId: string): Promise<FilingDeadline[]> {
    const d = await this.deadlines.deadlines(companyId)
    const { today, rhythm, dauerfrist, bundesland: land } = d
    const until = addDaysIso(today, HORIZON_DAYS)
    const rows: FilingDeadline[] = [...d.deadlines]
    const seen = new Set(rows.map(key))
    const add = (kind: FilingDeadline['kind'], p: Period, due: string, noteCode: keyof typeof NOTES | null, amount?: number) => {
      const row: FilingDeadline = {
        kind, year: p.year, month: p.month ?? null, quarter: p.quarter ?? null, periodName: periodName(p),
        periodEnd: p.month || p.quarter ? periodEnd(p) : isoDay(p.year, 12, 0), dueDate: due, daysLeft: daysBetween(today, due),
        status: 'open', noteCode, note: noteCode ? NOTES[noteCode] : null, ...(amount ? { amount } : {}),
      }
      if (due < today || due > until || seen.has(key(row))) return
      seen.add(key(row))
      rows.push(row)
    }

    // the UStVA periods after the running one
    if (rhythm !== 'none') {
      let p = periodContaining(today, rhythm)
      for (let i = 0; i < 13; i++) {
        p = nextPeriod(p)
        add('ustva', p, ustvaDeadline(p, dauerfrist, land), null)
      }
    }
    // OSS: the running quarter and those after it, for a company in the scheme
    if (d.ossVerfahren) {
      let p = periodContaining(today, 'quarterly')
      for (let i = 0; i < 4; i++) {
        add('oss', p, ossDeadline(p), 'oss-nil')
        p = nextPeriod(p)
      }
    }
    // the prepayments entered for the quarters ahead
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } })
    const s = (company?.settings ?? {}) as Record<string, any>
    const year = Number(today.slice(0, 4))
    for (const tax of ['kst', 'gewst'] as PrepaymentTax[]) {
      const entered = s[tax === 'kst' ? 'kstVorauszahlungen' : 'gewstVorauszahlungen'] ?? {}
      for (const y of [year, year + 1]) {
        for (const q of [1, 2, 3, 4]) {
          const n = Number(entered?.[y]?.[`q${q}`])
          if (!Number.isFinite(n) || n <= 0) continue
          add(tax, { year: y, quarter: q }, prepaymentDeadline(tax, y, q, land), tax === 'kst' ? 'kst-paid-by-expense' : 'gewst-paid-by-expense', Math.round(n * 100) / 100)
        }
      }
    }
    // the annual returns of the running year
    add('annual', { year }, annualReturnDeadline(year, d.berater, land), d.kleinunternehmer ? 'annual-ku' : d.berater ? 'annual-berater' : 'annual-self')
    // the next Sondervorauszahlung (its amount is known from December)
    if (rhythm === 'monthly' && dauerfrist) {
      add('svz', { year: year + 1 }, sondervorauszahlungDeadline(year + 1, land), 'svz-estimate')
    }

    rows.sort((a, b) => (a.dueDate === b.dueDate ? a.kind.localeCompare(b.kind) : a.dueDate.localeCompare(b.dueDate)))
    return rows
  }
}
