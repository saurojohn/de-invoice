/**
 * Business-day (Werktag) arithmetic for German accounting.
 *
 * A Werktag in Germany is:
 *   - Monday through Friday
 *   - NOT a Feiertag (public holiday)
 *
 * Per BGB §193 + BGB §187, Mahnung frist + Verjährung
 * use Werktage — counting Saturday/Sunday/Feiertag as
 * "not a day" for these purposes. So if an invoice is
 * due on a Friday and the customer wants 7 Werktage to
 * pay, the deadline is the following Monday (skipping
 * the weekend). This is what users expect when they
 * see "7 Werktage" on a German Mahnung.
 *
 * Tier 846: the holidays are those of the company's Bundesland
 * (filing-deadlines.ts: nationwide, plus the ones of the whole Land; a
 * company without a Land has the nationwide ones). They were a table of its
 * own here — Heilige Drei Könige, Mariä Himmelfahrt, Fronleichnam and
 * Allerheiligen for every company, no Reformationstag or Frauentag for any,
 * and Easter only up to 2030.
 */
import { publicHolidays } from '../reports/filing-deadlines'

const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Is the given date a public holiday in the Land (nationwide ones without it)? */
export function isHoliday(d: Date, land?: string | null): boolean {
  return publicHolidays(d.getFullYear(), land).has(isoOf(d))
}

/**
 * Is the given date a Werktag (Mon-Fri + not a holiday)?
 */
export function isWerktag(d: Date, land?: string | null): boolean {
  const day = d.getDay()
  if (day === 0 || day === 6) return false
  if (isHoliday(d, land)) return false
  return true
}

/**
 * Count Werktage between two dates (inclusive of start,
 * exclusive of end — matches how German courts count
 * "X Werktage Frist"). If start > end, returns negative.
 *
 * Example: countWerktage(2026-06-12 Fri, 2026-06-22 Mon)
 *   = 6 (Fri, Mon, Tue, Wed, Thu, Fri)
 */
export function countWerktage(from: Date, to: Date, land?: string | null): number {
  if (from.getTime() === to.getTime()) return 0
  const step = from.getTime() < to.getTime() ? 1 : -1
  let count = 0
  const cur = new Date(from)
  // Move past `from` so the function is exclusive on
  // the start (matches "from today + 7 Werktage" pattern).
  cur.setDate(cur.getDate() + step)
  while (
    (step > 0 && cur.getTime() < to.getTime()) ||
    (step < 0 && cur.getTime() > to.getTime())
  ) {
    if (isWerktag(cur, land)) count += step
    cur.setDate(cur.getDate() + step)
  }
  return count
}

/**
 * Add N Werktage to a date, returning the new date.
 * If the start is a non-Werktag, the first Werktag >= start
 * is used (so "5 Werktage from Sunday" → next Friday, not
 * "5 days from Sunday" which lands on Friday).
 */
export function addWerktage(start: Date, n: number, land?: string | null): Date {
  const cur = new Date(start)
  // If start is not a Werktag, advance to next Werktag
  // without counting.
  if (!isWerktag(cur, land)) {
    while (!isWerktag(cur, land)) {
      cur.setDate(cur.getDate() + 1)
    }
  }
  let added = 0
  while (added < n) {
    cur.setDate(cur.getDate() + 1)
    if (isWerktag(cur, land)) added += 1
  }
  return cur
}
