/**
 * Tier 842 — the Kleinunternehmerregelung (§ 19 UStG) by date.
 *
 * Whether a supply, a purchase or a month falls under § 19 is a matter of its
 * date: the regulation is decided per calendar year (no more than 25 000 €
 * last year) and ends at once within one (over 100 000 € this year: from the
 * supply that crosses the limit on). The app read `Company.defaultVatMode` as
 * it is today for every period, so switching it turned the whole history
 * over. Measured: a Kleinunternehmer's 105 000 € of 2026 moved from EÜR 4120
 * (§ 19) to 4170 (steuerfrei) when the mode was set to `standard`.
 *
 *  - mode 'kleinunternehmer': § 19 applies from `kleinunternehmerAb` on
 *    (null: since always), and up to an earlier period's `kleinunternehmerBis`
 *  - another mode: § 19 applied up to `kleinunternehmerBis` (null: never),
 *    from `kleinunternehmerAb` on if that is set
 *
 * Without a date the predicate answers with the mode as it is today — the
 * behaviour before, for a row whose date a caller does not have.
 */
import { businessDayIso } from './business-date'

export const KU_SELECT = { defaultVatMode: true, kleinunternehmerAb: true, kleinunternehmerBis: true } as const

export type KuCompany =
  | { defaultVatMode?: string | null; kleinunternehmerAb?: Date | null; kleinunternehmerBis?: Date | null }
  | null
  | undefined

type Day = Date | string | null | undefined
/** whether § 19 applies on a day; `bounds` are the days the answer may change after */
export type KuOn = ((d?: Day) => boolean) & { bounds?: string[] }
/** a fixed answer, or by date */
export type Ku = boolean | KuOn

// the German calendar day: a stored date is UTC midnight, a report's bound
// may be a local midnight (new Date(year, 0, 1)) — both are that day in Germany
const dayOf = (d: Date | string): string => (typeof d === 'string' ? d.slice(0, 10) : businessDayIso(d))

export function kuOn(c: KuCompany): KuOn {
  const mode = c?.defaultVatMode === 'kleinunternehmer'
  const ab = c?.kleinunternehmerAb ? dayOf(c.kleinunternehmerAb) : null
  const bis = c?.kleinunternehmerBis ? dayOf(c.kleinunternehmerBis) : null
  const on = (d?: Day) => {
    if (d == null) return mode
    const x = dayOf(d)
    const upToBis = bis !== null && x <= bis
    if (mode) return ab === null || x >= ab || upToBis
    return upToBis && (ab === null || x >= ab)
  }
  // the answer can change on `ab` and on the day after `bis`
  const bounds = [ab, bis !== null ? nextDay(bis) : null].filter((x): x is string => x !== null)
  return Object.assign(on, { bounds })
}

function nextDay(d: string): string {
  const t = new Date(d + 'T00:00:00.000Z')
  t.setUTCDate(t.getUTCDate() + 1)
  return t.toISOString().slice(0, 10)
}

/** § 19 on a day, for a fixed answer or one by date */
export function kuAt(ku: Ku, d?: Day): boolean {
  return typeof ku === 'function' ? ku(d) : ku
}

/** whether § 19 applies on any day of [from, to] (calendar days, inclusive) */
export function kuWithin(ku: Ku, from: Date | string, to: Date | string): boolean {
  if (typeof ku !== 'function') return ku
  const f = dayOf(from)
  const t = dayOf(to)
  // the answer changes only on the bounds: both ends and every bound inside
  return [f, t, ...(ku.bounds ?? []).filter((b) => b > f && b < t)].some((d) => ku(d))
}

/** whether § 19 applies on every day of [from, to] */
export function kuThroughout(ku: Ku, from: Date | string, to: Date | string): boolean {
  if (typeof ku !== 'function') return ku
  const f = dayOf(from)
  const t = dayOf(to)
  return [f, t, ...(ku.bounds ?? []).filter((b) => b > f && b < t)].every((d) => ku(d))
}

/**
 * Tier 844 — the day that decides § 19 for a document: its issue date, and
 * for a credit note the date of the invoice it corrects. A correction follows
 * what it corrects (§ 17 UStG): the Storno of a § 19 invoice is § 19 turnover
 * taken back, also when the regulation has ended since; the credit note of a
 * taxed invoice takes back tax, also from a company that has become a
 * Kleinunternehmer. Measured: a § 19 invoice of March credited in November,
 * after the regulation had ended on 30.06., stood in the UStVA as −1 000 €
 * of „sonstige steuerfreie Umsätze“.
 */
export function kuDayOf(doc: {
  type?: string | null
  issueDate?: Date | string | null
  referenceInvoice?: { issueDate?: Date | string | null } | null
}): Date | string | null | undefined {
  return doc.type === 'CN' && doc.referenceInvoice?.issueDate ? doc.referenceInvoice.issueDate : doc.issueDate
}
