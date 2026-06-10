/**
 * Bank statement parsers — MT940 (SWIFT) + CAMT.053 (SEPA XML).
 *
 * Both formats are widely used in German banking:
 *   - MT940: older SWIFT proprietary format, still default
 *     export for many banks (Sparkasse, Volksbank, etc).
 *     Plain text with `:`-prefixed tags.
 *   - CAMT.053: SEPA XML standard, increasingly common,
 *     pushed by ECB for PSD2 / PSD3 compliance. Structured
 *     XML with namespaces.
 *
 * We deliberately do not pull in a library (no `mt940`, no
 * `camt053`, no `xml2js`) — these formats are small enough
 * that a focused parser is more debuggable than a third-
 * party module that breaks on edge cases. Both parsers
 * return a uniform `ParsedStatement` shape so the rest of
 * the service can treat them identically.
 */

export interface ParsedStatement {
  format: 'mt940' | 'camt053'
  accountIban?: string
  bankName?: string
  periodFrom?: Date
  periodTo?: Date
  openingBalance?: number
  closingBalance?: number
  currency: string
  transactions: ParsedTransaction[]
}

export interface ParsedTransaction {
  valueDate: Date
  entryDate?: Date
  /** Positive = incoming (Gutschrift), negative = outgoing (Lastschrift). */
  amount: number
  currency: string
  counterpartyName?: string
  counterpartyIban?: string
  purpose?: string
  endToEndId?: string
}
