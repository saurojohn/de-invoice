import { registerDecorator, ValidationOptions } from 'class-validator'

/**
 * Tier 846 — a calendar day in a request: YYYY-MM-DD, a day that exists, in a
 * year a business record can have (1900 – 2199).
 *
 * The date fields were checked against /^\d{4}-\d{2}-\d{2}$/ alone, which
 * „2026-13-01“ and „0000-00-00“ pass. `new Date(…)` of that is an Invalid
 * Date, and what followed answered 500: Prisma on a recurring template's
 * startDate, `toISOString()` on a time entry's date (measured with a probe
 * of odd values, 16.11.2026). „9999-12-31“ is a date, and a template
 * starting then ran its schedule past what a Date holds.
 */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
export const CALENDAR_DAY_MIN_YEAR = 1900
export const CALENDAR_DAY_MAX_YEAR = 2199

export function isCalendarDay(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = DAY.exec(v)
  if (!m) return false
  const year = Number(m[1])
  if (year < CALENDAR_DAY_MIN_YEAR || year > CALENDAR_DAY_MAX_YEAR) return false
  const d = new Date(`${v}T00:00:00.000Z`)
  // 2026-02-31 parses as 03.03.: the day read back must be the day given
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export function IsCalendarDay(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isCalendarDay',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isCalendarDay(value),
        defaultMessage: (args) => `${args?.property} muss ein Datum sein, das es gibt (JJJJ-MM-TT)`,
      },
    })
}
