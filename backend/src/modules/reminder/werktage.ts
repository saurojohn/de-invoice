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
 * Implementation note: we hardcode the most common
 * German federal + Bayern/Hessen/BB/SH/NRW holidays
 * (the Bundesländer where Kleinunternehmer typically
 * operate). NOT exhaustive — Saxony has Buß- und Bettag
 * that floats, Bayern has HeiligeDreiKönige + Fronleichnam
 * + Allerheiligen, etc. Production would consume an
 * official ical feed. For a 1-tenant MVP this is fine
 * and overridable per-company via Company.settings.
 */

const FIXED_HOLIDAYS = new Set([
  "01-01", // Neujahr
  "05-01", // Tag der Arbeit
  "10-03", // Tag der Deutschen Einheit
  "12-25", // 1. Weihnachtstag
  "12-26", // 2. Weihnachtstag
])

// Catholic / state-specific (Bayern default — covers
// the most common Kleinunternehmer states). A real
// production app would key this off Company.state.
const STATE_HOLIDAYS = new Set([
  "01-06", // Heilige Drei Könige (BY, BW, ST)
  "08-15", // Mariä Himmelfahrt (BY, SL)
  "11-01", // Allerheiligen (BY, BW, NW, RP, SL)
])

// Easter-dependent holidays (move every year).
// Pre-computed for 2025-2030; outside that range we
// return the date set without Easter holidays.
const EASTER_DATES: Record<number, string> = {
  2025: "2025-04-20",
  2026: "2026-04-05",
  2027: "2027-03-28",
  2028: "2028-04-16",
  2029: "2029-04-01",
  2030: "2030-04-21",
}
const EASTER_OFFSETS: Array<[number, string]> = [
  [-2, "Karfreitag"],
  [1, "Ostermontag"],
  [39, "Christi Himmelfahrt"],
  [50, "Pfingstmontag"],
  [60, "Fronleichnam"], // BY/BW/Hessen/RP/NW
]

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * Is the given date a public holiday (combined federal
 * + state) in our default holiday set?
 */
export function isHoliday(d: Date): boolean {
  const key = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  if (FIXED_HOLIDAYS.has(key)) return true
  if (STATE_HOLIDAYS.has(key)) return true
  const easter = EASTER_DATES[d.getFullYear()]
  if (!easter) return false
  const easterDate = new Date(easter + "T00:00:00Z")
  for (const [offset] of EASTER_OFFSETS) {
    const holiday = new Date(easterDate)
    holiday.setUTCDate(holiday.getUTCDate() + offset)
    if (
      holiday.getUTCFullYear() === d.getFullYear() &&
      holiday.getUTCMonth() === d.getMonth() &&
      holiday.getUTCDate() === d.getDate()
    ) {
      return true
    }
  }
  return false
}

/**
 * Is the given date a Werktag (Mon-Fri + not a holiday)?
 */
export function isWerktag(d: Date): boolean {
  const day = d.getDay()
  if (day === 0 || day === 6) return false
  if (isHoliday(d)) return false
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
export function countWerktage(from: Date, to: Date): number {
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
    if (isWerktag(cur)) count += step
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
export function addWerktage(start: Date, n: number): Date {
  const cur = new Date(start)
  // If start is not a Werktag, advance to next Werktag
  // without counting.
  if (!isWerktag(cur)) {
    while (!isWerktag(cur)) {
      cur.setDate(cur.getDate() + 1)
    }
  }
  let added = 0
  while (added < n) {
    cur.setDate(cur.getDate() + 1)
    if (isWerktag(cur)) added += 1
  }
  return cur
}
