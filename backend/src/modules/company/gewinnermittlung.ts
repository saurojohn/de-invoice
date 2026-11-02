/**
 * Tier 464 — how the company determines its profit.
 *
 * 'euer': Einnahmen-Überschuss-Rechnung (§ 4 Abs. 3 EStG) — income and
 * expenses count when the money moves (§ 11 EStG, accounting/euer-zufluss.ts).
 * 'bilanz': Betriebsvermögensvergleich (§ 4 Abs. 1, § 5 EStG) — accrual, by
 * document date.
 *
 * Not set, it follows the legal form (Tier 441): a Kaufmann must keep books
 * (§ 238 HGB, § 140 AO) — OHG, KG, GmbH & Co. KG and every corporation; a
 * sole trader, freelancer, GbR or PartG may use the EÜR (below the § 141 AO
 * thresholds — a sole trader above them, or a registered e. K., sets
 * 'bilanz'). An unknown legal form counts as EÜR, the small-business case.
 *
 * Anlage G used the document date for everyone. Measured, a sole trader with an
 * invoice of November 2025 paid in January 2026 and a cash sale in December:
 * Anlage G 2025 said 1 000 € income (the EÜR 100), 2026 said 0 (the EÜR
 * 1 000) — and the cash sale was in no Anlage G at all.
 */
import { resolveRechtsform } from './rechtsform'

export type Gewinnermittlung = 'euer' | 'bilanz'

const BILANZPFLICHTIG = ['OHG', 'KG', 'GmbH & Co. KG', 'GmbH', 'UG (haftungsbeschränkt)', 'AG', 'KGaA']

/**
 * Tier 774: a Kaufmann by legal form keeps books whatever was set (§§ 238, 242
 * HGB; § 6 HGB, § 13 Abs. 3 GmbHG; § 5 EStG via § 8 KStG). 'euer' set for a
 * GmbH made every report count by payment; it is not one of its choices.
 */
export function euerNotAllowedFor(rechtsform: string | null): boolean {
  return !!rechtsform && BILANZPFLICHTIG.includes(rechtsform)
}

export function resolveGewinnermittlung(company: {
  gewinnermittlung?: string | null
  rechtsform?: string | null
  settings?: unknown
  legalName?: string | null
  name?: string | null
}): { art: Gewinnermittlung; source: 'gesetzt' | 'rechtsform' } {
  const rf = resolveRechtsform(company).rechtsform
  if (euerNotAllowedFor(rf)) return { art: 'bilanz', source: company.gewinnermittlung === 'bilanz' ? 'gesetzt' : 'rechtsform' }
  if (company.gewinnermittlung === 'euer' || company.gewinnermittlung === 'bilanz') {
    return { art: company.gewinnermittlung, source: 'gesetzt' }
  }
  return { art: 'euer', source: 'rechtsform' }
}
