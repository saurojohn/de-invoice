/**
 * Tier 656 — § 23 Abs. 3 Satz 5 EStG: gains from private sales stay tax-free
 * when their total in the calendar year is LESS THAN the limit — 1 000 € from
 * 2024 on (Wachstumschancengesetz), 600 € before. It is a Freigrenze, not an
 * allowance: at the limit or above it, the whole gain is taxable.
 * (Read from gesetze-im-internet.de on 10.10.2026.)
 *
 * Before: 600 € for every year, "≤ 600 → tax-free", and in the service the
 * page uses the limit was SUBTRACTED from the gain — 3 000 € of gain were
 * shown as 2 400 € taxable.
 */
export const freigrenzeFor = (year: number): number => (year >= 2024 ? 1000 : 600)

/** What is taxable of a year's net gain from private sales. */
export const afterFreigrenze = (gain: number, year: number): number =>
  gain > 0 && gain >= freigrenzeFor(year) ? gain : 0
