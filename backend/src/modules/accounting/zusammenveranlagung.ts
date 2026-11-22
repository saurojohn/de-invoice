/**
 * Tier 911 — Zusammenveranlagung by year.
 *
 * Whether spouses are assessed together is chosen for each Veranlagungsjahr
 * (§ 26 EStG — married and not living apart on any day of the year). It was
 * one flag (`settings.zusammenveranlagung`) read for every year: ticking it on
 * the 2026 page doubled the Sparer-Pauschbetrag of 2025's Anlage KAP and the
 * child allowances of 2025's Anlage Kind too.
 *
 * Now it is kept per year (`settings.zusammenveranlagungAb`, { "2026": true }):
 * a choice holds from its year until a later one; a year before the first
 * keeps the flag stored before.
 */
export function zusammenveranlagungOf(settings: unknown, year: number): boolean {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {}
  const byYear = s.zusammenveranlagungAb && typeof s.zusammenveranlagungAb === 'object' && !Array.isArray(s.zusammenveranlagungAb)
    ? (s.zusammenveranlagungAb as Record<string, unknown>)
    : {}
  let best: { y: number; v: boolean } | null = null
  for (const [k, v] of Object.entries(byYear)) {
    const y = Number(k)
    if (!Number.isInteger(y) || typeof v !== 'boolean' || y > year) continue
    if (!best || y > best.y) best = { y, v }
  }
  return best ? best.v : s.zusammenveranlagung === true
}
