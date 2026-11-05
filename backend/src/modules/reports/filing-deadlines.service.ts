import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { businessDayIso, businessTodayIso } from '../../common/business-date'
import { UstvaService } from './ustva.service'
import { OssService } from './oss.service'
import {
  Period, UstvaRhythm, daysBetween, lastEndedPeriod, ossDeadline, periodContaining, periodEnd, periodName, previousPeriod,
  ustvaDeadline, zmDeadline, annualReturnDeadline, sondervorauszahlungDeadline, isoDay,
  prepaymentDeadline, prepaymentTaxOf, addDaysIso, type PrepaymentTax,
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

// Tier 802: 'option' — something that may be done by the day (apply for the Dauerfristverlängerung)
export type DeadlineStatus = 'filed' | 'open' | 'overdue' | 'running' | 'option'

export interface FilingDeadline {
  // Tier 802: 'annual' — the annual returns; 'svz' — the Sondervorauszahlung;
  // 'dauerfrist' — the application for the Dauerfristverlängerung
  // Tier 804: 'kst' / 'gewst' — the quarterly prepayments of the Vorauszahlungsbescheide
  kind: 'ustva' | 'zm' | 'oss' | 'annual' | 'svz' | 'dauerfrist' | 'kst' | 'gewst'
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
  /** Tier 802: the Sondervorauszahlung, 1/11 of the previous year's Vorauszahlungen — an estimate;
   *  Tier 804: the prepayment the Bescheid sets — exact */
  amount?: number
}

const RHYTHMS: UstvaRhythm[] = ['monthly', 'quarterly', 'none']
const SUBMITTED = ['submitted', 'accepted']
/** How many ended periods are looked at for a missing UStVA. */
const LOOKBACK = { monthly: 3, quarterly: 2 } as const
/** § 18a Abs. 1 Satz 2 UStG: supplies of goods over this a quarter are reported monthly. */
const ZM_MONTHLY_THRESHOLD = 50_000

export const NOTES = {
  'zm-monthly': `Innergemeinschaftliche Lieferungen über ${ZM_MONTHLY_THRESHOLD.toLocaleString('de-DE')} € im Quartal — die ZM ist ab jetzt monatlich abzugeben (§ 18a Abs. 1 UStG).`,
  'oss-nil': 'Im OSS-Verfahren ist auch ohne Umsätze eine Nullmeldung abzugeben.',
  'oss-check': 'Verkäufe an Verbraucher im EU-Ausland — prüfen, ob die OSS-Meldung nötig ist (Lieferschwelle 10 000 €, § 3c UStG).',
  'annual-self': 'Umsatzsteuer-, Einkommen- bzw. Körperschaftsteuer- und Gewerbesteuererklärung — ohne Steuerberater.',
  'annual-berater': 'Umsatzsteuer-, Einkommen- bzw. Körperschaftsteuer- und Gewerbesteuererklärung — durch den Steuerberater (§ 149 Abs. 3 AO).',
  'annual-ku': 'Einkommen- und Gewerbesteuererklärung; als Kleinunternehmer seit 2024 keine Umsatzsteuererklärung, wenn das Finanzamt sie nicht anfordert (§ 19 Abs. 1 Satz 4 UStG).',
  'svz-estimate': '1/11 der Vorauszahlungen des Vorjahres (§ 47 UStDV), aus den Buchungen geschätzt — mit der USt 1 H anmelden und zahlen.',
  'svz-partial': '1/11 der bisherigen Vorauszahlungen des laufenden Jahres (§ 47 UStDV) — vorläufig, das Jahr ist noch nicht zu Ende.',
  'dauerfrist-monthly': 'Mit Dauerfristverlängerung ist jede Voranmeldung einen Monat später fällig; dafür ist bis dahin eine Sondervorauszahlung von 1/11 der Vorjahres-Vorauszahlungen zu leisten (§§ 46–48 UStDV).',
  'dauerfrist-quarterly': 'Mit Dauerfristverlängerung ist jede Voranmeldung einen Monat später fällig; vierteljährlich ohne Sondervorauszahlung (§ 46 UStDV).',
  'kst-paid-by-expense': 'Laut Vorauszahlungsbescheid (KSt + Solidaritätszuschlag). Als gezahlt gilt sie, sobald eine Ausgabe der Kategorie „Körperschaftsteuer“ bzw. „Solidaritätszuschlag“ um den Termin sie deckt.',
  'gewst-paid-by-expense': 'Laut Gewerbesteuer-Vorauszahlungsbescheid der Gemeinde. Als gezahlt gilt sie, sobald eine Ausgabe der Kategorie „Gewerbesteuer“ um den Termin sie deckt.',
} as const

/** Tier 804: an expense of the tax this many days before to this many after a due date pays it. */
const PAID_WINDOW = { before: 45, after: 30 } as const
const PREPAYMENT_SETTING: Record<PrepaymentTax, string> = { kst: 'kstVorauszahlungen', gewst: 'gewstVorauszahlungen' }

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
      // Tier 802: the annual returns are prepared by a Steuerberater (§ 149 Abs. 3 AO)
      berater: s.jahreserklaerungDurchBerater === true,
      // Tier 803: the reminder mails (on unless switched off)
      erinnerungMail: s.fristErinnerungMail !== false,
      kleinunternehmer: company?.defaultVatMode === 'kleinunternehmer',
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

    // Tier 802: the annual returns of the ended years whose deadline is ahead.
    // A Kleinunternehmer files no annual VAT return since 2024 unless asked
    // (§ 19 Abs. 1 Satz 4 UStG, Wachstumschancengesetz) — the ESt and GewSt
    // returns remain, same deadline.
    const year = Number(today.slice(0, 4))
    for (const y of [year - 2, year - 1]) {
      const due = annualReturnDeadline(y, st.berater, land)
      if (due < today) continue
      const settled = await this.prisma.ustPayment.count({ where: { companyId, kind: 'ustja', year: y } })
      const p: Period = { year: y }
      out.push(item('annual', p, `${y}-12-31`, due, settled > 0 ? 'filed' : 'open', st.kleinunternehmer ? 'annual-ku' : st.berater ? 'annual-berater' : 'annual-self'))
    }

    // Tier 802: the Sondervorauszahlung (monthly with Dauerfrist), or the
    // application for the Dauerfristverlängerung — from December to the day
    if (rhythm === 'monthly') {
      const target = today.slice(5) >= '12-01' ? year + 1 : year
      const due = sondervorauszahlungDeadline(target, land)
      if (due >= today && today >= `${target - 1}-12-01`) {
        if (dauerfrist) {
          const paid = await this.prisma.ustPayment.count({ where: { companyId, kind: 'sondervorauszahlung', year: target } })
          const base = await this.ustva.compute(companyId, target - 1)
          const amount = Math.max(0, Math.round((Number(base.differenzbetrag) / 11) * 100) / 100)
          const row = item('svz', { year: target }, isoDay(target, 0, 0), due, paid > 0 ? 'filed' : 'open', target - 1 === year ? 'svz-partial' : 'svz-estimate')
          out.push({ ...row, amount })
        } else {
          out.push(item('dauerfrist', { year: target }, isoDay(target, 0, 0), due, 'option', 'dauerfrist-monthly'))
        }
      }
    } else if (rhythm === 'quarterly' && !dauerfrist) {
      const due = ustvaDeadline({ year, quarter: 1 }, false, land)
      if (due >= today && today >= `${year}-03-01`) {
        out.push(item('dauerfrist', { year }, isoDay(year, 0, 0), due, 'option', 'dauerfrist-quarterly'))
      }
    }

    // Tier 804: the KSt and GewSt prepayments the company entered from its
    // Bescheide (Buchhaltung → KSt 1 / Gewerbesteuer): the next one, and the
    // one before while it is unpaid — overdue only for a company that books
    // these taxes as expenses here (otherwise nothing here says it was paid).
    out.push(...(await this.prepayments(companyId, today, land, item)))

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

  private async prepayments(
    companyId: string,
    today: string,
    land: string | null,
    item: (kind: FilingDeadline['kind'], p: Period, end: string, due: string, status: DeadlineStatus, noteCode?: keyof typeof NOTES | null) => FilingDeadline,
  ): Promise<FilingDeadline[]> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } })
    const s = (company?.settings ?? {}) as Record<string, any>
    const year = Number(today.slice(0, 4))
    const quarters: Period[] = [{ year: year - 1, quarter: 4 }, ...[1, 2, 3, 4].map((q) => ({ year, quarter: q })), { year: year + 1, quarter: 1 }]
    const amountOf = (tax: PrepaymentTax, p: Period) => {
      const n = Number(s[PREPAYMENT_SETTING[tax]]?.[p.year]?.[`q${p.quarter}`])
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
    }
    // per tax: the one due next, and the one before it
    const wanted: Array<{ tax: PrepaymentTax; p: Period; due: string; amount: number; next: boolean }> = []
    for (const tax of ['kst', 'gewst'] as PrepaymentTax[]) {
      const dues = quarters.map((p) => ({ p, due: prepaymentDeadline(tax, p.year, p.quarter!, land) }))
      const i = dues.findIndex((d) => d.due >= today)
      for (const [d, next] of [[dues[i], true], [dues[i - 1], false]] as const) {
        if (!d) continue
        const amount = amountOf(tax, d.p)
        if (amount > 0) wanted.push({ tax, p: d.p, due: d.due, amount, next })
      }
    }
    if (wanted.length === 0) return []

    // the expenses of these taxes around the due dates — by the day paid, else
    // the day dated (a day wider here; the German day is compared below)
    const from = addDaysIso(wanted.map((w) => w.due).sort()[0], -PAID_WINDOW.before - 1)
    const to = addDaysIso(wanted.map((w) => w.due).sort().slice(-1)[0], PAID_WINDOW.after + 2)
    const range = { gte: new Date(`${from}T00:00:00Z`), lt: new Date(`${to}T00:00:00Z`) }
    const [expenses, categories] = await Promise.all([
      this.prisma.expense.findMany({
        where: { companyId, OR: [{ paidAt: range }, { paidAt: null, invoiceDate: range }] },
        select: { category: true, grossAmount: true, paidAt: true, invoiceDate: true },
      }),
      this.prisma.expense.findMany({ where: { companyId, category: { not: null } }, select: { category: true }, distinct: ['category'] }),
    ])
    // the taxes this company books as expenses at all
    const booksTax = new Set(categories.map((e) => prepaymentTaxOf(e.category)).filter((t): t is PrepaymentTax => t !== null))

    const rows: FilingDeadline[] = []
    for (const w of wanted) {
      const lo = addDaysIso(w.due, -PAID_WINDOW.before)
      const hi = addDaysIso(w.due, PAID_WINDOW.after)
      const paidSum = expenses
        .filter((e) => prepaymentTaxOf(e.category) === w.tax)
        .map((e) => ({ day: businessDayIso(e.paidAt ?? e.invoiceDate), amount: Number(e.grossAmount) }))
        .filter((e) => e.day >= lo && e.day <= hi)
        .reduce((a, e) => a + e.amount, 0)
      const paid = paidSum >= w.amount - 0.005
      let status: DeadlineStatus
      if (paid) {
        if (!w.next) continue
        status = 'filed'
      } else if (w.next) {
        status = 'open'
      } else if (booksTax.has(w.tax)) {
        status = 'overdue'
      } else continue
      const p = w.p
      const row = item(w.tax, p, periodEnd(p), w.due, status, w.tax === 'kst' ? 'kst-paid-by-expense' : 'gewst-paid-by-expense')
      rows.push({ ...row, amount: w.amount })
    }
    return rows
  }
}
