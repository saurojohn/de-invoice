// DATEV USt-Schlüssel mapping for the German DATEV
// Buchungsstapel export.
//
// Background — what is the USt-Schlüssel?
// The USt-Schlüssel (DATEV column 12) is a 2-digit
// key that tells the Berater (Steuerberater) what
// VAT rate / treatment to use when preparing the
// UStVA. The Berater's DATEV software turns the
// key into a UStVA-Kennzahl automatically.
//
// Why we need this mapping
// de-invoice stores VAT rates as decimals (0.19,
// 0.07, etc.) because that's what users see on
// their invoices. The DATEV export, however, needs
// the USt-Schlüssel code. This file is the single
// source of truth for that conversion.
//
// Tax keys (DATEV Steuerschlüssel, two digits; Tier 423 replaced a list
// that did not match DATEV's):
//   2 / 3   Umsatzsteuer 7 % / 19 %
//   5       Umsatzsteuer 16 % (second half of 2020)
//   8 / 9   Vorsteuer 7 % / 19 %
//   7       Vorsteuer 16 % (second half of 2020)
//   18 / 19 innergemeinschaftlicher Erwerb 7 % / 19 % (USt and VSt)
//   91 / 94 § 13b UStG, Leistungsempfänger schuldet, 7 % / 19 %
// A tax-free booking carries no key: the account decides (8125 steuerfreie
// igL, 8336/8337 Leistungen nach § 13b / § 3a, …). Revenue on an
// Automatikkonto (8400, 8300) needs no key either — DATEV splits the tax
// itself — but the key does no harm there and keeps the export readable for
// Beraters who use non-automatic revenue accounts.
//
// If the Berater tells you "this is wrong", the fix is here — NOT in the
// invoice or in the UI.

export type UstSchluesselMode =
  | 'output'        // USt we CHARGE on our sales invoices
  | 'input'         // Vorsteuer we PAID on our purchase bills
  | 'igE'           // Innergemeinschaftlicher Erwerb
  | 'reverseCharge' // §13b UStG Steuerschuldnerschaft
  | 'legacy'        // 5%/16% — historical keys for old imports

// Three-letter code to describe the Steuerschlüssel
// in user-facing error messages (avoid 2-digit number
// confusion: "0" looks like a typo of "1" or "8").
export interface UstSchluesselResult {
  key: string
  name: string        // German name, for error messages
  legacy?: boolean    // true = 5% / 16% (deprecated)
}

const RATE_TOLERANCE = 0.001

/**
 * Convert a VAT rate to the matching DATEV USt-Schlüssel
 * for the given scenario. Returns a typed result so the
 * caller can show a meaningful German error if a rate
 * doesn't match anything (e.g. a 0.16 rate entered in
 * 2026 — that's a legacy COVID rate and should be flagged).
 *
 * @param vatRate decimal rate (0.19, 0.07, etc.)
 *                — NOT a percentage (19)
 * @param mode which DATEV scenario to look up
 */
export function vatRateToUstSchluessel(
  vatRate: number | null | undefined,
  mode: UstSchluesselMode = 'output',
): UstSchluesselResult | null {
  if (vatRate === null || vatRate === undefined) {
    return null
  }
  const r = Number(vatRate)
  if (Number.isNaN(r)) return null

  // Tier 423: the standard DATEV two-digit Steuerschlüssel. The keys used
  // before were invented: 19 % USt was "1" (DATEV's key 1 is *steuerfrei mit
  // Vorsteuerabzug*), input tax "20"/"21" (no such keys), igE "14"/"15" and
  // § 13b "12"/"13" (12/13 are intra-EU supplies to buyers *without* a VAT id).
  // Checked against the published DATEV key list (see HANDOFF §8, Tier 423).
  //   2 USt 7 %   3 USt 19 %   5 USt 16 %
  //   8 VSt 7 %   9 VSt 19 %   7 VSt 16 %
  //   18 / 19 innergemeinschaftlicher Erwerb 7 % / 19 %
  //   91 / 94 § 13b, Leistungsempfänger schuldet, 7 % / 19 %
  const is = (x: number) => Math.abs(r - x) < RATE_TOLERANCE
  switch (mode) {
    case 'output': {
      if (is(0.19)) return { key: '3', name: 'Umsatzsteuer 19 %' }
      if (is(0.07)) return { key: '2', name: 'Umsatzsteuer 7 %' }
      if (is(0)) return { key: '', name: 'steuerfrei (Konto bestimmt den Sachverhalt)' }
      return null
    }
    case 'legacy': {
      if (is(0.05)) return { key: '2', name: 'Umsatzsteuer 5 % (2020)', legacy: true }
      if (is(0.16)) return { key: '5', name: 'Umsatzsteuer 16 % (2020)', legacy: true }
      return null
    }
    case 'igE': {
      if (is(0.19)) return { key: '19', name: 'innergemeinschaftlicher Erwerb 19 %' }
      if (is(0.07)) return { key: '18', name: 'innergemeinschaftlicher Erwerb 7 %' }
      return null
    }
    case 'reverseCharge': {
      if (is(0.19)) return { key: '94', name: '§ 13b UStG, Leistungsempfänger schuldet, 19 %' }
      if (is(0.07)) return { key: '91', name: '§ 13b UStG, Leistungsempfänger schuldet, 7 %' }
      return null
    }
    case 'input': {
      if (is(0.19)) return { key: '9', name: 'Vorsteuer 19 %' }
      if (is(0.07)) return { key: '8', name: 'Vorsteuer 7 %' }
      if (is(0.16)) return { key: '7', name: 'Vorsteuer 16 % (2020)', legacy: true }
      if (is(0.05)) return { key: '8', name: 'Vorsteuer 5 % (2020)', legacy: true }
      if (is(0)) return { key: '', name: 'ohne Vorsteuer' }
      return null
    }
  }
}

/**
 * The output-VAT key for a rate ("3", "2", …), "" when there is none (tax
 * free, or a rate DATEV has no key for — the Berater decides).
 */
export function outputUstSchluessel(vatRate: number | null | undefined): string {
  const result = vatRateToUstSchluessel(vatRate, 'output')
  return result?.key ?? ''
}
