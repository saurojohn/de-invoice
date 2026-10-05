import { BadRequestException } from '@nestjs/common'
/**
 * Tier 478 — calendar days of the business (Europe/Berlin).
 *
 * Date-only fields (issueDate, dueDate, invoiceDate) are stored as midnight
 * UTC of their calendar day ("2026-09-30" → 2026-09-30T00:00:00Z). Comparing
 * them with `new Date()` or with local-midnight bounds mixes two clocks: on a
 * server in Germany, an invoice dated today lies in the future until 02:00
 * (the dashboard's "this month" showed 0 € for today's invoices after
 * midnight — spec 213 at 00:11 on 30.09.), and on a UTC server an invoice due
 * today counts as overdue all day. These helpers give the bounds as the same
 * midnight-UTC values the dates are stored as, for the business's own day.
 */

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Today's calendar day in Germany: year, month (0-11), day. */
export function businessToday(now: Date = new Date()): { y: number; m: number; d: number } {
  const [y, m, d] = fmt.format(now).split('-').map(Number)
  return { y, m: m - 1, d }
}

/** Midnight UTC of a calendar day — how date-only fields are stored. Month may overflow (Date.UTC rules). */
export function dayStart(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d))
}

/** The last millisecond of a calendar day, in the same representation. */
export function dayEnd(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d, 23, 59, 59, 999))
}

/**
 * "YYYY-MM-DD" of the German calendar day a stored value falls on. Same as
 * the UTC date for date-only values (midnight UTC is 01:00 / 02:00 in Germany);
 * right for full instants too ("2026-09-29T23:40Z" is 30.09. in Germany).
 */
export function businessDayIso(date: Date): string {
  return fmt.format(date)
}

/** "YYYY-MM-DD" of today in Germany. */
export function businessTodayIso(now: Date = new Date()): string {
  return businessDayIso(now)
}

/**
 * Today's German calendar day as a date-only value (midnight UTC) — for a
 * date the system sets itself ("booked today"). `new Date()` stored the
 * instant: between 00:00 and 02:00 in Germany that is the previous day's
 * date, and on the 1st the previous month's period.
 */
export function businessTodayDate(now: Date = new Date()): Date {
  const { y, m, d } = businessToday(now)
  return dayStart(y, m, d)
}

/**
 * Tier 515 — a date something happened on cannot be after today (German
 * calendar day): a payment made, a supplier's invoice received, an invoice
 * issued. Tier 514 did it for customer payments; the others still took
 * 2030, booking the amount into a future year's EÜR / UStVA.
 */
export function assertNotFuture(date: Date | string | null | undefined, label: string): void {
  if (!date) return
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return
  if (businessDayIso(d) > businessTodayIso()) {
    throw new BadRequestException(`${label} liegt in der Zukunft.`)
  }
}

/**
 * Tier 519a — the last millisecond of a German calendar day as an
 * instant ("through 30.09." for a value compared with `new Date()`). Not
 * 23:59:59.999Z: that is 01:59 of the next day in Germany in summer — a
 * pause "until yesterday" was still running until 02:00.
 */
export function businessDayEndInstant(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  for (const offsetHours of [2, 1]) {
    const t = new Date(Date.UTC(y, m - 1, d, 23 - offsetHours, 59, 59, 999))
    if (businessDayIso(t) === iso && businessDayIso(new Date(t.getTime() + 1)) !== iso) return t
  }
  return new Date(Date.UTC(y, m - 1, d, 22, 59, 59, 999))
}
