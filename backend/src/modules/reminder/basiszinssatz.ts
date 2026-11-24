/**
 * Tier 421 — Verzugszinsen per § 288 BGB on the Basiszinssatz (§ 247 BGB).
 *
 * The rate is the Basiszinssatz plus 9 percentage points between businesses
 * (§ 288 Abs. 2) or plus 5 points when the debtor is a consumer (Abs. 1). The
 * Basiszinssatz changes on 1 January and 1 July; interest for a period that
 * spans a change is computed per segment. The app charged a flat 9 % a year:
 * from 1 July 2026 (Basiszinssatz 1,52 %) that is 1,52 points too little from
 * a business and 2,48 points more than the law allows from a consumer.
 *
 * Source: Deutsche Bundesbank, "Basiszinssatz" (checked 21.09.2026). The table
 * has to be extended every half year; `basiszinssatzAt` uses the latest known
 * value for later dates.
 */
import { businessTodayIso } from '../../common/business-date'

const TABLE: Array<[string, number]> = [
  ['2016-07-01', -0.88],
  ['2023-01-01', 1.62],
  ['2023-07-01', 3.12],
  ['2024-01-01', 3.62],
  ['2024-07-01', 3.37],
  ['2025-01-01', 2.27],
  ['2025-07-01', 1.27],
  ['2026-01-01', 1.27],
  ['2026-07-01', 1.52],
]

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Tier 753: the rate changes on 1 January and 1 July, the table in a release.
 * From the day a half year has begun without its rate here the interest is
 * reckoned with the last one, and this says so.
 */
export function basiszinssatzWarning(now: Date = new Date()): string | null {
  const [year, month] = businessTodayIso(now).split('-').map(Number)
  const due = `${year}-${month >= 7 ? '07' : '01'}-01`
  const [lastFrom, lastRate] = TABLE[TABLE.length - 1]
  if (lastFrom >= due) return null
  const day = due.split('-').reverse().join('.')
  return `Der Basiszinssatz ab ${day} ist noch nicht hinterlegt. Verzugszinsen werden mit dem letzten bekannten Satz (${String(lastRate).replace('.', ',')} %) berechnet.`
}

export function basiszinssatzAt(day: Date): number {
  const k = dayKey(day)
  let rate = TABLE[0][1]
  for (const [from, r] of TABLE) if (from <= k) rate = r
  return rate
}

export interface InterestResult {
  amount: number
  /** the annual rate (Basiszinssatz + surcharge) on the last day */
  currentRate: number
  currentBasiszinssatz: number
  days: number
}

/**
 * Interest on `principal` for every day after `dueDate` up to and including
 * `asOf`, at Basiszinssatz + `surcharge` percentage points on each day.
 *
 * Tier 992: `principal` is what is open today; `paid` are the payments on
 * the claim. Up to and including its day a payment was still owed: the
 * interest runs on the debt as it stood on each day (§ 288 BGB). Measured
 * before: 10 000 € of 11 900 € paid after 158 days in default, and the
 * interest of those days on the 10 000 € was gone.
 */
export function verzugszinsen(
  principal: number,
  dueDate: Date,
  asOf: Date,
  surcharge: number,
  paid: Array<{ date: Date; amount: number }> = [],
): InterestResult {
  const dayOf = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const start = dayOf(dueDate) + 86_400_000
  const end = dayOf(asOf)
  const later = paid.map((p) => ({ day: dayOf(new Date(p.date)), amount: Number(p.amount) || 0 })).filter((p) => p.day >= start)
  let amountPctDays = 0
  let days = 0
  for (let t = start; t <= end; t += 86_400_000) {
    const pct = basiszinssatzAt(new Date(t)) + surcharge
    const owed = principal + later.reduce((sum, p) => (p.day >= t ? sum + p.amount : sum), 0)
    amountPctDays += Math.max(0, owed) * pct
    days++
  }
  const amount = Math.max(0, Math.round(amountPctDays / 365) / 100)
  const current = basiszinssatzAt(new Date(end))
  return { amount, currentRate: Math.round((current + surcharge) * 100) / 100, currentBasiszinssatz: current, days }
}
