import { BadRequestException } from '@nestjs/common'
import { isGermanRate } from '../reports/oss-scope'

/**
 * Tier 900 — input tax only from a rate German law has.
 *
 * Measured before: an expense at 50 %, one at 16 % dated today and a hotel bill
 * from Paris with 20 % French tax were stored, and all of it went into Kz 66
 * of the UStVA as Vorsteuer (93,80 € of which 7,80 € were deductible). A
 * § 13b purchase at 50 % put 50 € tax into Kz 84 / 85.
 *
 * - § 15 Abs. 1 Satz 1 Nr. 1 UStG: deductible is the tax owed by law for the
 *   supply. A rate German law does not have is tax shown wrongly (§ 14c UStG):
 *   the supplier owes it, the customer cannot deduct it.
 * - Tax of another member state is not German Vorsteuer at all. It is refunded
 *   by that state through the BZSt portal (§ 18g UStG) — in the books it is a
 *   cost until then.
 * - A farmer taxed by § 24 UStG invoices his average rate, and that is
 *   tax owed by law and deductible: 5,5 % for forestry, for the rest
 *   10,7 % until 2021, 9,5 % in 2022, 9,0 % in 2023 and 2024, 7,8 % since 2025.
 * - § 13b / intra-community acquisition: the company itself owes German tax
 *   at 19 % or 7 % (0 = "not entered", 19 % assumed — Tier 417).
 */
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10)

export function isFarmerAverageRate(rate: number, date: Date | string): boolean {
  const r = Math.round(rate * 10000) / 10000
  const d = day(date)
  if (r === 0.055) return true
  if (r === 0.107) return d <= '2021-12-31'
  if (r === 0.095) return d >= '2022-01-01' && d <= '2022-12-31'
  if (r === 0.09) return d >= '2023-01-01' && d <= '2024-12-31'
  if (r === 0.078) return d >= '2025-01-01'
  return false
}

const pct = (r: number) => `${(Math.round(r * 10000) / 100).toLocaleString('de-DE')} %`

/**
 * Why these rates cannot carry input tax on this date — or null.
 * `lines` are the expense's VAT lines (rate and VAT amount); only a line that
 * shows tax counts — a foreign bill entered with its tax as cost (0 € VAT) is
 * fine whatever rate it names.
 */
export function inputTaxRateError(
  lines: { rate: number; vat: number }[],
  date: Date | string,
  reverseCharge: boolean,
): string | null {
  if (reverseCharge) {
    const bad = lines.find((l) => l.rate > 0 && !isGermanRate(l.rate, date))
    if (!bad) return null
    return `Bei § 13b / innergemeinschaftlichem Erwerb schuldet das Unternehmen deutsche Umsatzsteuer — 19 % oder 7 % (§ 12 UStG), nicht ${pct(bad.rate)}.`
  }
  const bad = lines.find((l) => l.rate > 0 && Math.round(Number(l.vat) * 100) !== 0 && !isGermanRate(l.rate, date) && !isFarmerAverageRate(l.rate, date))
  if (!bad) return null
  return `Vorsteuer gibt es nur aus einem Steuersatz des deutschen Rechts — 19 % oder 7 % (§ 12 UStG), bei einem pauschalierenden Landwirt sein Durchschnittssatz (§ 24 UStG), nicht ${pct(bad.rate)} (§ 15 Abs. 1 Nr. 1 UStG). Ausländische Umsatzsteuer ist keine deutsche Vorsteuer: die Ausgabe mit 0 % und dem Bruttobetrag als Kosten erfassen; die Erstattung läuft über das BZSt (§ 18g UStG).`
}

export function assertInputTaxRate(lines: { rate: number; vat: number }[], date: Date | string, reverseCharge: boolean): void {
  const error = inputTaxRateError(lines, date, reverseCharge)
  if (error) throw new BadRequestException(error)
}

/**
 * A cash booking with VAT (Kassenbuch, no invoice or expense behind it): a
 * cash sale on the premises is a German supply at 19 % / 7 % (Kz 81 / 86), a
 * cash purchase carries input tax by the rules above.
 */
export function cashRateError(type: string, rate: number | null | undefined, date: Date | string): string | null {
  if (rate == null || !(rate > 0)) return null
  if (type === 'ausgabe') return inputTaxRateError([{ rate, vat: 1 }], date, false)
  if (type === 'einnahme' && !isGermanRate(rate, date)) {
    return `Ein Barverkauf ist ein Umsatz im Inland — 19 % oder 7 % (§ 12 UStG), nicht ${pct(rate)}.`
  }
  return null
}
