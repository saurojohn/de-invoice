// Tier 688 — why a sale carries no German VAT, decided in one place.
//
// The UStVA (Tier 410/417) sorted zero-rated sales by the invoice's flags and
// the customer's country and VAT id; the invoice itself did not follow it:
//   - an intra-EU supply named "§1a UStG" — the buyer's acquisition, not the
//     seller's exemption (§ 4 Nr. 1 Buchst. b, § 6a UStG);
//   - an export to a third country (Kz 43) carried no note at all, though
//     § 14 Abs. 4 Nr. 8 UStG asks for the exemption to be named;
//   - a service to a business outside the EU (Kz 45, not taxable here) was
//     printed as "Steuerschuldnerschaft des Leistungsempfängers (§13b UStG)" —
//     a German rule for a recipient abroad;
//   - the XRechnung / ZUGFeRD said "E, Steuerbefreite Leistung" for an export
//     and for an EU customer's 0 % sale that the UStVA counts as igL.
// The UStVA, the PDF and the e-invoice now ask zeroRatedGround().
import { normaliseCountry } from './ust-behandlung-detector'

const EU_MEMBER_STATES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DE', 'DK', 'EE', 'FI', 'FR', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]
export const isEuMemberState = (country: string): boolean => EU_MEMBER_STATES.includes(country.toUpperCase())

export type ZeroRatedGround =
  | 'igl' //                     intra-EU supply of goods (Kz 41)
  | 'reverseChargeEu' //         B2B service, place of supply in another member state (Kz 21)
  | 'reverseChargeDomestic' //   § 13b UStG, the German recipient owes the tax (Kz 60)
  | 'notTaxableAbroad' //        B2B service, place of supply outside the EU (Kz 45)
  | 'export' //                  export to a third country (Kz 43)
  | 'exempt' //                  some other exemption — the program does not know which

/**
 * The ground of a zero-rated sale. The invoice's own igL / § 13b flags are
 * the user's explicit statement and win over any inference (Tier 417).
 * `country` may be a name ("Frankreich") or a code.
 */
export function zeroRatedGround(
  flags: { euTransaction?: boolean | null; reverseCharge?: boolean | null },
  countryInput: string | null | undefined,
  vatIdInput: string | null | undefined,
): ZeroRatedGround {
  const country = normaliseCountry(countryInput ?? '') || ''
  const vatId = String(vatIdInput ?? '').replace(/\s+/g, '').toUpperCase()
  if (flags.euTransaction === true) return 'igl'
  if (flags.reverseCharge === true) {
    if (country && country !== 'DE' && isEuMemberState(country)) return 'reverseChargeEu'
    if (country && !isEuMemberState(country)) return 'notTaxableAbroad'
    return 'reverseChargeDomestic'
  }
  // an EU customer with a (foreign) VAT id: an intra-EU supply
  if (!vatId.startsWith('DE') && country && isEuMemberState(country) && vatId) return 'igl'
  if (country && !isEuMemberState(country)) return 'export'
  return 'exempt'
}

/** Tier 688: what the invoice says for each ground. igL and § 13b come from the template (editable). */
export const IGL_NOTE = 'Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b i. V. m. § 6a UStG).'
/** The template default before Tier 688 — read as the new one (a stored template kept the wrong §). */
export const IGL_NOTE_BEFORE_688 = 'Steuerfreie innergemeinschaftliche Lieferung (§1a UStG).'
export const EXPORT_NOTE = 'Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG).'
export const NOT_TAXABLE_ABROAD_NOTE = 'Nicht im Inland steuerbare Leistung (Leistungsort im Drittland, § 3a Abs. 2 UStG).'
