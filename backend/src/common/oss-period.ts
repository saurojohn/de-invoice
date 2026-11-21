/**
 * Tier 909 — the One-Stop-Shop by date.
 *
 * `Company.ossVerfahren` says whether the company is in the OSS scheme today.
 * Read as it is for every period, turning it on moved the past: a 1 000 € sale
 * of October to a consumer in Paris, taxed at 19 % in Germany (Kz 81) and
 * filed, stood afterwards in Kz 45 — and in the OSS return of the quarter,
 * whose tax went to France a second time.
 *
 * Whether a sale is the OSS's is a matter of its day (§ 18j UStG: the scheme
 * applies from the first day of the quarter after the notice, or from the
 * first supply above the threshold). Each change is kept in
 * `Company.settings.ossWechsel` as { ab: 'YYYY-MM-01', on, vorher }; without
 * one the column answers for every day — as before.
 */
import { businessDayIso } from './business-date'

export interface OssWechsel { ab: string; on: boolean; vorher: boolean }
export const OSS_SELECT = { ossVerfahren: true, settings: true } as const
type OssCompany = { ossVerfahren?: boolean | null; settings?: unknown } | null | undefined

const dayOf = (d: Date | string): string => (typeof d === 'string' ? d.slice(0, 10) : businessDayIso(d))

/** the changes stored, oldest first */
export function ossWechselOf(c: OssCompany): OssWechsel[] {
  const s = c?.settings
  const raw = s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>).ossWechsel : null
  if (!Array.isArray(raw)) return []
  return raw
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object' && typeof (w as any).ab === 'string' && /^\d{4}-\d{2}-01$/.test((w as any).ab))
    .map((w) => ({ ab: String(w.ab), on: w.on === true, vorher: w.vorher === true }))
    .sort((a, b) => a.ab.localeCompare(b.ab))
}

/** whether the company was in the OSS scheme on a day */
export function ossOn(c: OssCompany): (d: Date | string) => boolean {
  const today = c?.ossVerfahren === true
  const list = ossWechselOf(c)
  if (list.length === 0) return () => today
  return (d) => {
    const day = dayOf(d)
    let on = list[0].vorher
    for (const w of list) if (w.ab <= day) on = w.on
    return on
  }
}
