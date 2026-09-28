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

export function resolveGewinnermittlung(company: {
  gewinnermittlung?: string | null
  rechtsform?: string | null
  settings?: unknown
  legalName?: string | null
  name?: string | null
}): { art: Gewinnermittlung; source: 'gesetzt' | 'rechtsform' } {
  if (company.gewinnermittlung === 'euer' || company.gewinnermittlung === 'bilanz') {
    return { art: company.gewinnermittlung, source: 'gesetzt' }
  }
  const rf = resolveRechtsform(company).rechtsform
  return { art: rf && BILANZPFLICHTIG.includes(rf) ? 'bilanz' : 'euer', source: 'rechtsform' }
}
