/**
 * Tier 910 — the Hebesatz of a year.
 *
 * The Hebesatz is the municipality's (§ 16 GewStG) and changes now and then
 * (a council's Haushaltssatzung, or a move). It was one number,
 * `Company.settings.hebesatz`, read for every year: entering this year's new
 * Hebesatz recomputed the Gewerbesteuer of every year before — the Anlage G,
 * the GewSt 1A and the KSt 1 of a year already filed, and the tax provision of
 * a balance sheet already closed.
 *
 * Now the GewSt settings (which name a year) keep it per year in
 * `settings.hebesatzAb` ({ "2026": 450 }): a Hebesatz holds from its year
 * until a later one. A year before the first entry keeps the number stored
 * before (`settings.hebesatz`), else 400.
 */
export const HEBESATZ_DEFAULT = 400

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

export function hebesatzOf(settings: unknown, year: number): number {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {}
  const byYear = s.hebesatzAb && typeof s.hebesatzAb === 'object' && !Array.isArray(s.hebesatzAb) ? (s.hebesatzAb as Record<string, unknown>) : {}
  let best: { y: number; v: number } | null = null
  for (const [k, v] of Object.entries(byYear)) {
    const y = Number(k)
    const n = positive(v)
    if (!Number.isInteger(y) || n === null || y > year) continue
    if (!best || y > best.y) best = { y, v: n }
  }
  return best?.v ?? positive(s.hebesatz) ?? HEBESATZ_DEFAULT
}
