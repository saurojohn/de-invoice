/**
 * Tier 442 — supplier credit notes (Lieferantengutschrift).
 *
 * A supplier's credit note — goods returned, a price reduction, a refund —
 * had no place: both expense endpoints required amounts ≥ 0 and rejected any
 * other field, and the CSV import skipped negative rows. The input tax already
 * claimed on the original invoice stayed claimed (§ 17 Abs. 1 UStG requires
 * the correction), and the cost stayed in full.
 *
 * A credit note is entered with positive amounts and `creditNote: true`, and
 * stored as an expense with NEGATIVE amounts. The reports sum the amounts, so
 * it lowers the cost (GuV, BWA, EÜR, Anlage S / G), the input tax (UStVA) and
 * what is owed to the supplier (balance sheet); DATEV books it on the other
 * side (a negative amount flips S/H). It is no bill: the SEPA payment run and
 * the cash book do not pay it.
 */
export function signedExpenseAmounts(
  creditNote: boolean | undefined,
  amounts: { net: number; vat: number; gross: number },
): { net: number; vat: number; gross: number } {
  if (!creditNote) return amounts
  const neg = (n: number) => -Math.abs(n)
  return { net: neg(amounts.net), vat: neg(amounts.vat), gross: neg(amounts.gross) }
}

export const isCreditNoteRow = (e: { grossAmount: unknown }) => Number(e.grossAmount) < 0
