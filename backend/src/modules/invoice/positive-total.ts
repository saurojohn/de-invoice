import { BadRequestException } from '@nestjs/common'

/**
 * Tier 499 — a document's total (before a credit note's sign) is positive.
 * An INV of −595 € was accepted: a credit note without its invoice (§ 31
 * Abs. 5 UStDV wants the reference), counted as negative revenue; a 0 €
 * invoice is no invoice. Negative lines (a discount) are fine as long as the
 * total stays above 0.
 */
export function assertPositiveTotal(total: number): void {
  if (!(total > 0)) {
    throw new BadRequestException(
      'Der Rechnungsbetrag muss größer als 0 sein. Eine Minderung oder Rückzahlung ist eine Gutschrift — ' +
      'erstellen Sie sie über „Gutschrift" an der ursprünglichen Rechnung.',
    )
  }
}
