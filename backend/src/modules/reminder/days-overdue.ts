import { businessDayIso, businessTodayIso } from '../../common/business-date'

/**
 * Tier 528 — whole calendar days an invoice is overdue, in Germany.
 *
 * A due date is stored as midnight UTC of its day. Five places counted the
 * days each in its own way; two of them subtracted it from the server's
 * *local* midnight — on a server in Germany (production runs with
 * TZ=Europe/Berlin) that is 22:00 / 23:00 UTC of the day before, so the
 * result was one day short: an invoice due 40 days ago stood in the dunning
 * list and on the Mahnung with "39 Tage überfällig", while the fee preview
 * said 40. Due yesterday was "0 days overdue".
 */
export function daysOverdue(dueDate: Date | string | null | undefined, now: Date = new Date()): number {
  if (!dueDate) return 0
  const due = new Date(dueDate)
  if (Number.isNaN(due.getTime())) return 0
  const ms = (iso: string) => Date.parse(iso + 'T00:00:00.000Z')
  return Math.max(0, Math.round((ms(businessTodayIso(now)) - ms(businessDayIso(due))) / 86_400_000))
}
