/**
 * Tier 908 — Soll- or Ist-Versteuerung by date.
 *
 * `Company.besteuerungsart` is the way the company is taxed today. Read as it
 * is for every period, a change turned the whole history over. Measured: a
 * 1 000 € invoice of October, taxed and filed under Soll (Kz 81, 190 €); the
 * company switched to Ist in November and was paid in November — the November
 * UStVA declared the 190 € a second time, and October, computed again, showed
 * nothing. The other way an invoice issued under Ist and paid after a switch
 * to Soll was in no return at all.
 *
 * The rule (§ 13 Abs. 1 Nr. 1 a / b, § 20 UStG): a sale is taxed once — when
 * it is issued if the company was a Soll-Versteuerer then, else when it is
 * paid, whenever that is. A credit note follows the invoice it corrects.
 *
 * Each switch is kept in `Company.settings.besteuerungsartWechsel` as
 * { ab: 'YYYY-MM-01', art, vorher } — from `ab` on `art`, before it `vorher`.
 * Without a switch the answer is the column, for every day — as before.
 */
import { businessDayIso } from './business-date'

export type Besteuerungsart = 'soll' | 'ist'
export interface ArtWechsel { ab: string; art: Besteuerungsart; vorher: Besteuerungsart }

export const ART_SELECT = { besteuerungsart: true, settings: true } as const
type ArtCompany = { besteuerungsart?: string | null; settings?: unknown } | null | undefined

const norm = (a: unknown): Besteuerungsart => (a === 'ist' ? 'ist' : 'soll')
const dayOf = (d: Date | string): string => (typeof d === 'string' ? d.slice(0, 10) : businessDayIso(d))

/** the switches stored, oldest first */
export function wechselOf(c: ArtCompany): ArtWechsel[] {
  const s = c?.settings
  const raw = s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>).besteuerungsartWechsel : null
  if (!Array.isArray(raw)) return []
  return raw
    .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object' && typeof (w as any).ab === 'string' && /^\d{4}-\d{2}-01$/.test((w as any).ab))
    .map((w) => ({ ab: String(w.ab), art: norm(w.art), vorher: norm(w.vorher) }))
    .sort((a, b) => a.ab.localeCompare(b.ab))
}

/** Soll or Ist on a day */
export function artOn(c: ArtCompany): (d: Date | string) => Besteuerungsart {
  const today = norm(c?.besteuerungsart)
  const list = wechselOf(c)
  if (list.length === 0) return () => today
  return (d) => {
    const day = dayOf(d)
    let art = list[0].vorher
    for (const w of list) if (w.ab <= day) art = w.art
    return art
  }
}
