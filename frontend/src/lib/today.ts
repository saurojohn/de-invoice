/**
 * Tier 554 — today's calendar day in Germany, as "YYYY-MM-DD".
 *
 * The ISO string of `new Date()`, cut to ten characters, is the UTC day: between midnight
 * and 02:00 German time it is yesterday. A form opened then proposed
 * yesterday as the invoice / payment date, and a date field with
 * `max={today}` refused today. The backend judges dates by the German
 * calendar day (common/business-date.ts); this is the same day.
 */
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

export function todayIso(now: Date = new Date()): string {
  return fmt.format(now)
}
