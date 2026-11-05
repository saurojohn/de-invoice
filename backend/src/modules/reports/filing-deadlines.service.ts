import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { businessTodayIso } from '../../common/business-date'
import { UstvaService } from './ustva.service'
import { OssService } from './oss.service'
import {
  Period, UstvaRhythm, daysBetween, lastEndedPeriod, ossDeadline, periodContaining, periodEnd, periodName, previousPeriod,
  ustvaDeadline, zmDeadline,
} from './filing-deadlines'

/**
 * Tier 801 — the returns that are due next, for the dashboard, and the period
 * the UStVA, ZM and OSS pages open on. Rules in filing-deadlines.ts.
 *
 * The UStVA rhythm and the Dauerfristverlängerung are the Finanzamt's
 * decision; the company states them under "Umsatzsteuer"
 * (settings.ustvaRhythmus, settings.dauerfristverlaengerung). Until it does,
 * they are taken from what the books show — the shape of the last saved
 * return, a Sondervorauszahlung of this or last year, a Kleinunternehmer —
 * and the answer says so (`source`), so the page can ask for them.
 */

export type DeadlineStatus = 'filed' | 'open' | 'overdue' | 'running'

export interface FilingDeadline {
  kind: 'ustva' | 'zm' | 'oss'
  year: number
  month: number | null
  quarter: number | null
  periodName: string
  periodEnd: string
  dueDate: string
  daysLeft: number
  status: DeadlineStatus
  /** for the page to translate: 'zm-monthly' | 'oss-nil' | 'oss-check' */
  noteCode: string | null
  note: string | null
}

const RHYTHMS: UstvaRhythm[] = ['monthly', 'quarterly', 'none']
const SUBMITTED = ['submitted', 'accepted']
/** How many ended periods are looked at for a missing UStVA. */
const LOOKBACK = { monthly: 3, quarterly: 2 } as const
/** § 18a Abs. 1 Satz 2 UStG: supplies of goods over this a quarter are reported monthly. */
const ZM_MONTHLY_THRESHOLD = 50_000

const NOTES = {
  'zm-monthly': `Innergemeinschaftliche Lieferungen über ${ZM_MONTHLY_THRESHOLD.toLocaleString('de-DE')} € im Quartal — die ZM ist ab jetzt monatlich abzugeben (§ 18a Abs. 1 UStG).`,
  'oss-nil': 'Im OSS-Verfahren ist auch ohne Umsätze eine Nullmeldung abzugeben.',
  'oss-check': 'Verkäufe an Verbraucher im EU-Ausland — prüfen, ob die OSS-Meldung nötig ist (Lieferschwelle 10 000 €, § 3c UStG).',
} as const

@Injectable()
export class FilingDeadlinesService {
  constructor(
    private prisma: PrismaService,
    private ustva: UstvaService,
    private oss: OssService,
  ) {}

  async settings(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true, defaultVatMode: true, bundesland: true, ossVerfahren: true },
    })
    const s = (company?.settings ?? {}) as Record<string, unknown>
    const today = businessTodayIso()
    const year = Number(today.slice(0, 4))

    let rhythm: UstvaRhythm
    let rhythmSource: 'setting' | 'filings' | 'kleinunternehmer' | 'default'
    if (RHYTHMS.includes(s.ustvaRhythmus as UstvaRhythm)) {
      rhythm = s.ustvaRhythmus as UstvaRhythm
      rhythmSource = 'setting'
    } else {
      const last = await this.prisma.uStvaFiling.findFirst({
        where: { companyId, year: { lte: year }, OR: [{ month: { not: null } }, { quarter: { not: null } }] },
        orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
        select: { month: true, quarter: true },
      })
      if (last) {
        rhythm = last.month != null ? 'monthly' : 'quarterly'
        rhythmSource = 'filings'
      } else if (company?.defaultVatMode === 'kleinunternehmer') {
        rhythm = 'none'
        rhythmSource = 'kleinunternehmer'
      } else {
        rhythm = 'monthly'
        rhythmSource = 'default'
      }
    }

    let dauerfrist: boolean
    let dauerfristSource: 'setting' | 'sondervorauszahlung' | 'default'
    if (typeof s.dauerfristverlaengerung === 'boolean') {
      dauerfrist = s.dauerfristverlaengerung
      dauerfristSource = 'setting'
    } else {
      const svz = await this.prisma.ustPayment.count({
        where: { companyId, kind: 'sondervorauszahlung', year: { in: [year, year - 1] } },
      })
      dauerfrist = svz > 0
      dauerfristSource = svz > 0 ? 'sondervorauszahlung' : 'default'
    }

    return {
      today,
      rhythm,
      rhythmSource,
      dauerfrist,
      dauerfristSource,
      bundesland: company?.bundesland ?? null,
      ossVerfahren: company?.ossVerfahren === true,
    }
  }

  async deadlines(companyId: string) {
    const st = await this.settings(companyId)
    const { today, rhythm, dauerfrist, bundesland: land } = st
    const out: FilingDeadline[] = []
    const item = (kind: FilingDeadline['kind'], p: Period, end: string, due: string, status: DeadlineStatus, noteCode: keyof typeof NOTES | null = null): FilingDeadline => ({
      kind, year: p.year, month: p.month ?? null, quarter: p.quarter ?? null, periodName: periodName(p),
      periodEnd: end, dueDate: due, daysLeft: daysBetween(today, due), status, noteCode, note: noteCode ? NOTES[noteCode] : null,
    })
    const endOf = periodEnd

    // UStVA — the ended periods still to be filed, then the running one
    let ustvaDefault: Period | null = null
    if (rhythm !== 'none') {
      const filings = await this.prisma.uStvaFiling.findMany({
        where: { companyId, status: { in: SUBMITTED } },
        select: { year: true, month: true, quarter: true, submittedAt: true },
      })
      const filed = (p: Period) =>
        filings.some((f) => f.year === p.year && (p.month ? f.month === p.month : f.month == null && f.quarter === p.quarter))
      // A missing return counts as overdue only after the first one recorded
      // here — before it, the returns were filed elsewhere.
      const firstFiled = filings
        .filter((f) => f.month != null || f.quarter != null)
        .map((f) => endOf({ year: f.year, month: f.month ?? undefined, quarter: f.month == null ? f.quarter ?? undefined : undefined }))
        .sort()[0]
      const ended: Period[] = []
      let p = lastEndedPeriod(today, rhythm)
      for (let i = 0; i < LOOKBACK[rhythm]; i++) { ended.unshift(p); p = previousPeriod(p) }
      for (const per of ended) {
        const due = ustvaDeadline(per, dauerfrist, land)
        const end = endOf(per)
        const isFiled = filed(per)
        if (isFiled) {
          if (due >= today) out.push(item('ustva', per, end, due, 'filed'))
        } else if (due >= today) {
          out.push(item('ustva', per, end, due, 'open'))
          ustvaDefault ??= per
        } else if (firstFiled && end > firstFiled) {
          out.push(item('ustva', per, end, due, 'overdue'))
          ustvaDefault ??= per
        }
      }
      const running = periodContaining(today, rhythm)
      out.push(item('ustva', running, endOf(running), ustvaDeadline(running, dauerfrist, land), 'running'))
      ustvaDefault ??= lastEndedPeriod(today, rhythm)
    }

    // ZM — the last ended quarter, when it has anything to report
    const zmPeriod = lastEndedPeriod(today, 'quarterly')
    const zmDue = zmDeadline(zmPeriod, land)
    if (zmDue >= today) {
      const zm = await this.ustva.computeZm(companyId, zmPeriod.year, zmPeriod.quarter)
      if (zm.rows.length > 0) {
        out.push(item('zm', zmPeriod, endOf(zmPeriod), zmDue, 'open', zm.summen.L > ZM_MONTHLY_THRESHOLD ? 'zm-monthly' : null))
      }
    }

    // OSS — the last ended quarter: always for a company in the scheme (a nil
    // return is due as well), otherwise when the quarter has such sales
    const ossPeriod = lastEndedPeriod(today, 'quarterly')
    const ossDue = ossDeadline(ossPeriod)
    if (ossDue >= today) {
      let show = st.ossVerfahren
      if (!show) {
        const r = await this.oss.compute(companyId, ossPeriod.year, ossPeriod.quarter!)
        show = r.totals.invoiceCount > 0
      }
      if (show) out.push(item('oss', ossPeriod, endOf(ossPeriod), ossDue, 'open', st.ossVerfahren ? 'oss-nil' : 'oss-check'))
    }

    out.sort((a, b) => (a.dueDate === b.dueDate ? a.kind.localeCompare(b.kind) : a.dueDate.localeCompare(b.dueDate)))
    const q = lastEndedPeriod(today, 'quarterly')
    return {
      ...st,
      defaults: {
        ustva: ustvaDefault ? { year: ustvaDefault.year, month: ustvaDefault.month ?? null, quarter: ustvaDefault.quarter ?? null } : null,
        zm: { year: q.year, quarter: q.quarter! },
        oss: { year: q.year, quarter: q.quarter! },
      },
      deadlines: out,
    }
  }
}
