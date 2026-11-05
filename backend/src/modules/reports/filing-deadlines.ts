/**
 * Tier 801 — the filing deadlines of the VAT returns, and the period each
 * report should open on.
 *
 * The UStVA, ZM and OSS pages opened on the period that is still running (the
 * UStVA on the whole current year), so in January the December return was two
 * clicks away, and nothing in the app said when a return was due. These are
 * the rules the dashboard and the three pages now share:
 *
 *  - UStVA (§ 18 Abs. 1 UStG): the 10th day after the end of the month or
 *    quarter; one month later with Dauerfristverlängerung (§§ 46–48 UStDV).
 *  - ZM (§ 18a Abs. 1 UStG): the 25th day after the end of the quarter (of
 *    the month, for supplies of goods over 50 000 € a quarter). The
 *    Dauerfristverlängerung does not apply to it.
 *  - OSS (§ 18j Abs. 3 UStG): the last day of the month after the quarter.
 *    Shown unshifted: the EU rule (Art. 364 MwStSystRL) knows no extension
 *    to the next working day, and sources differ on whether § 108 Abs. 3 AO
 *    applies — the earlier day is the safe one.
 *  - § 108 Abs. 3 AO: a deadline that ends on a Saturday, a Sunday or a
 *    statutory holiday ends on the next working day. Holidays are those of
 *    the company's Bundesland (where its Finanzamt is); without one, only the
 *    nationwide holidays count, which never gives a day too late.
 *
 *
 * Tier 802 — the annual return and the Sondervorauszahlung:
 *
 *  - Annual returns (USt, ESt/KSt, GewSt; § 149 Abs. 2 AO): 31 July of the
 *    following year; prepared by a Steuerberater (§ 149 Abs. 3 AO) the end
 *    of February of the second following year. The Corona extensions are
 *    over: the year 2024 had 31.07.2025 / 30.04.2026, from 2025 on the rule
 *    stands (2025 with a Berater: 28.02.2027, a Sunday → 01.03.2027).
 *  - Sondervorauszahlung (§§ 47, 48 UStDV): a monthly filer with
 *    Dauerfristverlängerung files and pays 1/11 of the previous year's
 *    Vorauszahlungen by the deadline of the January return without the
 *    extension — 10 February. The extension itself stays granted until it is
 *    revoked; applying for it is possible by that day (by the Q1 deadline,
 *    10 April, for a quarterly filer, who pays no Sondervorauszahlung).
 *
 * All days are calendar days "YYYY-MM-DD" (Europe/Berlin), no clock times.
 */

export type UstvaRhythm = 'monthly' | 'quarterly' | 'none'

export interface Period {
  year: number
  month?: number
  quarter?: number
}

const pad = (n: number) => String(n).padStart(2, '0')
export const isoDay = (y: number, m0: number, d: number) => {
  const t = new Date(Date.UTC(y, m0, d))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number)
  return isoDay(y, m - 1, d + n)
}
const weekday = (iso: string) => new Date(iso + 'T00:00:00Z').getUTCDay()

/** Easter Sunday (Gregorian; Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return isoDay(year, month - 1, day)
}

/**
 * The statutory holidays of a year — nationwide, plus those of the whole of
 * one Bundesland. Holidays of single communities (Mariä Himmelfahrt in parts
 * of Bavaria, Fronleichnam in parts of Saxony and Thuringia, the Augsburger
 * Friedensfest) are left out: leaving one out gives an earlier day, never a
 * later one.
 */
export function publicHolidays(year: number, land?: string | null): Set<string> {
  const easter = easterSunday(year)
  const days = [
    `${year}-01-01`, addDays(easter, -2), addDays(easter, 1), `${year}-05-01`,
    addDays(easter, 39), addDays(easter, 50), `${year}-10-03`, `${year}-12-25`, `${year}-12-26`,
  ]
  const L = (land || '').toUpperCase()
  const inLand = (...codes: string[]) => codes.includes(L)
  if (inLand('BW', 'BY', 'ST')) days.push(`${year}-01-06`)
  if ((L === 'BE' && year >= 2019) || (L === 'MV' && year >= 2023)) days.push(`${year}-03-08`)
  if (inLand('BW', 'BY', 'HE', 'NW', 'RP', 'SL')) days.push(addDays(easter, 60))
  if (inLand('SL')) days.push(`${year}-08-15`)
  if (L === 'TH' && year >= 2019) days.push(`${year}-09-20`)
  if (inLand('BB', 'MV', 'SN', 'ST', 'TH') || (inLand('HB', 'HH', 'NI', 'SH') && year >= 2018)) days.push(`${year}-10-31`)
  if (inLand('BW', 'BY', 'NW', 'RP', 'SL')) days.push(`${year}-11-01`)
  if (L === 'SN') {
    // Buß- und Bettag: the Wednesday before 23 November
    for (let d = 16; d <= 22; d++) if (weekday(isoDay(year, 10, d)) === 3) days.push(isoDay(year, 10, d))
  }
  return new Set(days)
}

export function isWorkingDay(iso: string, land?: string | null): boolean {
  const wd = weekday(iso)
  if (wd === 0 || wd === 6) return false
  return !publicHolidays(Number(iso.slice(0, 4)), land).has(iso)
}

/** § 108 Abs. 3 AO: a deadline on a weekend or holiday ends on the next working day. */
export function shiftToWorkingDay(iso: string, land?: string | null): string {
  let d = iso
  while (!isWorkingDay(d, land)) d = addDays(d, 1)
  return d
}

/** The last month (1-12) of a period. */
const lastMonth = (p: Period) => (p.month ?? (p.quarter ? p.quarter * 3 : 12))

/** The last day of a period. */
export function periodEnd(p: Period): string {
  return isoDay(p.year, lastMonth(p), 0)
}

export function ustvaDeadline(p: Period, dauerfrist: boolean, land?: string | null): string {
  return shiftToWorkingDay(isoDay(p.year, lastMonth(p) + (dauerfrist ? 1 : 0), 10), land)
}

export function zmDeadline(p: Period, land?: string | null): string {
  return shiftToWorkingDay(isoDay(p.year, lastMonth(p), 25), land)
}

export function ossDeadline(p: Period): string {
  return isoDay(p.year, lastMonth(p) + 1, 0)
}

/** The period of a rhythm that contains a day. */
export function periodContaining(iso: string, rhythm: 'monthly' | 'quarterly'): Period {
  const [y, m] = iso.split('-').map(Number)
  return rhythm === 'monthly' ? { year: y, month: m } : { year: y, quarter: Math.ceil(m / 3) }
}

export function previousPeriod(p: Period): Period {
  if (p.month) return p.month === 1 ? { year: p.year - 1, month: 12 } : { year: p.year, month: p.month - 1 }
  const q = p.quarter ?? 1
  return q === 1 ? { year: p.year - 1, quarter: 4 } : { year: p.year, quarter: q - 1 }
}

/** The last period of a rhythm that has ended before the day. */
export function lastEndedPeriod(iso: string, rhythm: 'monthly' | 'quarterly'): Period {
  return previousPeriod(periodContaining(iso, rhythm))
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
export function periodName(p: Period): string {
  if (p.month) return `${MONTHS[p.month - 1]} ${p.year}`
  if (p.quarter) return `${p.quarter}. Quartal ${p.year}`
  return String(p.year)
}

/** Whole days from one calendar day to another (negative when past). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000)
}

/** The annual returns of a year: § 149 Abs. 2 / 3 AO, shifted by § 108 Abs. 3 AO. */
export function annualReturnDeadline(year: number, berater: boolean, land?: string | null): string {
  if (!berater) return shiftToWorkingDay(`${year + 1}-07-31`, land)
  if (year === 2024) return shiftToWorkingDay('2026-04-30', land)
  return shiftToWorkingDay(isoDay(year + 2, 2, 0), land)
}

/** The Sondervorauszahlung of a year, and the application for the Dauerfristverlängerung of a monthly filer. */
export function sondervorauszahlungDeadline(year: number, land?: string | null): string {
  return ustvaDeadline({ year, month: 1 }, false, land)
}
