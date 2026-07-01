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
// Tax key reference (DATEV Schlüsselverzeichnis,
// valid for tax year 2024+; keys from earlier years
// are kept here for legacy imports).
//
// Output VAT (Umsatzsteuer — what we CHARGE):
//   0  = steuerfrei (§19 UStG / Kleinunternehmer)
//   1  = 19% USt (Regelsatz — DEFAULT for 2024+)
//   2  = 7% USt (ermäßigt, since 2024 only 7%)
//   8  = 5% USt (LEGACY 2020-2023, no new bookings)
//   9  = 16% USt (LEGACY 2020 only, COVID)
//
// Output VAT with special treatment:
//   11 = §24 UStG Differenzbesteuerung (Gebrauchtwaren)
//   17 = 19% Reiseleistung §25 UStG
//   18 = 7%  Reiseleistung §25 UStG
//
// Input VAT (Vorsteuer — what we PAID):
//   20 = 19% Vorsteuer
//   21 = 7%  Vorsteuer
//   24 = 19% Vorsteuer aus IgE (§1a UStG)
//   25 = 7%  Vorsteuer aus IgE
//   26 = 19% Vorsteuer aus §13b Reverse-Charge
//   27 = 7%  Vorsteuer aus §13b Reverse-Charge
//
// IgE (Innergemeinschaftlicher Erwerb) — no output VAT,
// but we MUST report the VAT that the supplier would
// have charged (the Vorsteuer on the IgE goes to
// different accounts):
//   14 = 19% IgE (§1a Abs. 1 UStG)
//   15 = 7%  IgE
//   16 = 19% IgE Neufahrzeug (§1b UStG)
//
// §13b Reverse-Charge — we DON'T pay VAT to the
// supplier; the Steuerschuld goes to US:
//   12 = 19% Reverse-Charge
//   13 = 7%  Reverse-Charge
//
// In the de-invoice DATEV export, the USt-Schlüssel
// is read by the Berater's DATEV software, which
// picks the right UStVA-Kennzahl for that booking.
// The mapping in this file is the *single place*
// where we decide which key corresponds to which
// rate + scenario. If the Berater tells you "this
// is wrong, I expected 1 not 3", the fix is here
// — NOT in the invoice or in the UI.

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

  switch (mode) {
    case 'output': {
      // Output VAT — we charge on sales
      if (Math.abs(r - 0.19) < RATE_TOLERANCE) {
        return { key: '1', name: '19% USt (Regelsatz)' }
      }
      if (Math.abs(r - 0.07) < RATE_TOLERANCE) {
        return { key: '2', name: '7% USt (ermäßigt)' }
      }
      if (Math.abs(r - 0) < RATE_TOLERANCE) {
        return { key: '0', name: 'steuerfrei (§19 UStG)' }
      }
      return null
    }
    case 'legacy': {
      // 5% (Gastronomie 2020-2023) and 16% (COVID 2020).
      // For legacy import — flag as deprecated in the export
      // comment so the Berater can verify the period.
      if (Math.abs(r - 0.05) < RATE_TOLERANCE) {
        return { key: '8', name: '5% USt (LEGACY 2020-2023)', legacy: true }
      }
      if (Math.abs(r - 0.16) < RATE_TOLERANCE) {
        return { key: '9', name: '16% USt (LEGACY 2020 COVID)', legacy: true }
      }
      return null
    }
    case 'igE': {
      // Innergemeinschaftlicher Erwerb (§1a / §1b UStG)
      // Note: key 16 (IgE Neufahrzeug §1b) requires
      // explicit caller choice — the rate alone is
      // identical to regular IgE 19%, so we cannot
      // decide from the rate alone. The caller passes
      // `igE Neufahrzeug` via a separate flag and
      // picks key 16 themselves. See EXPORT-23 in
      // datev.service.ts for the wiring.
      if (Math.abs(r - 0.19) < RATE_TOLERANCE) {
        return { key: '14', name: '19% IgE (§1a Abs. 1 UStG)' }
      }
      if (Math.abs(r - 0.07) < RATE_TOLERANCE) {
        return { key: '15', name: '7% IgE (§1a Abs. 1 UStG)' }
      }
      return null
    }
    case 'reverseCharge': {
      // §13b UStG Steuerschuldnerschaft
      if (Math.abs(r - 0.19) < RATE_TOLERANCE) {
        return { key: '12', name: '19% Reverse-Charge (§13b UStG)' }
      }
      if (Math.abs(r - 0.07) < RATE_TOLERANCE) {
        return { key: '13', name: '7% Reverse-Charge (§13b UStG)' }
      }
      return null
    }
    case 'input': {
      // Vorsteuer (input VAT) — we paid on a purchase bill
      if (Math.abs(r - 0.19) < RATE_TOLERANCE) {
        return { key: '20', name: '19% Vorsteuer' }
      }
      if (Math.abs(r - 0.07) < RATE_TOLERANCE) {
        return { key: '21', name: '7% Vorsteuer' }
      }
      if (Math.abs(r - 0) < RATE_TOLERANCE) {
        return { key: '0', name: '0% Vorsteuer (steuerfrei)' }
      }
      return null
    }
  }
}

/**
 * Quick lookup used by the DATEV export — returns the
 * raw key string (e.g. "1", "2", "14") for the most
 * common output-VAT case. Returns "" when no match
 * (the caller writes an empty cell — the Berater
 * can then decide manually). Prefer
 * `vatRateToUstSchluessel` for new code — this is a
 * shim for the 3 call sites in datev.service.ts that
 * pass `vatRate` as a decimal in the `0.19/0.07/else-0`
 * pattern.
 */
export function outputUstSchluessel(vatRate: number | null | undefined): string {
  const result = vatRateToUstSchluessel(vatRate, 'output')
  return result?.key ?? ''
}
