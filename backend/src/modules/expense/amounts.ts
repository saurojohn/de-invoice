import { BadRequestException } from '@nestjs/common'

/**
 * Tier 523 — the three amounts of an expense belong together.
 *
 * Measured before: net 100 + VAT 19 with gross 500 was stored (the EÜR and
 * the UStVA read net and VAT, the payment and the Kreditor the gross — the
 * books of one bill did not add up); net 100 at 19 % with 90 € VAT was stored
 * and the 90 € went into the Vorsteuer; 19 € VAT at 0 % too.
 *
 * - gross = net + VAT (to the cent);
 * - the VAT is not more than the rate yields on the net — with a margin for
 *   a bill that rounds per line (2 %, at least 10 cents). Less is allowed:
 *   a reverse-charge bill or one from a Kleinunternehmer has none, and the
 *   part that is not deductible is entered as cost;
 * - net and VAT point the same way (a credit note is negative in all three).
 */
export function expenseAmountsError(a: { net: number; vat: number; gross: number; rate: number }): string | null {
  const cents = (n: number) => Math.round(Number(n) * 100)
  const eur = (c: number) => (c / 100).toFixed(2).replace('.', ',')
  const net = cents(a.net), vat = cents(a.vat), gross = cents(a.gross)
  if (![net, vat, gross].every(Number.isFinite) || !Number.isFinite(Number(a.rate))) {
    return 'Die Beträge der Ausgabe sind ungültig.'
  }
  if (Math.abs(net + vat - gross) > 1) {
    return `Netto (${eur(net)} €) und Umsatzsteuer (${eur(vat)} €) ergeben nicht den Bruttobetrag (${eur(gross)} €).`
  }
  if (vat !== 0 && net !== 0 && Math.sign(vat) !== Math.sign(net)) {
    return 'Nettobetrag und Umsatzsteuer haben verschiedene Vorzeichen.'
  }
  const most = Math.abs(net) * Number(a.rate)
  if (Math.abs(vat) > most + Math.max(10, most * 0.02)) {
    return `Die Umsatzsteuer (${eur(Math.abs(vat))} €) ist höher als ${Math.round(Number(a.rate) * 10000) / 100} % des Nettobetrags (${eur(Math.round(most))} €).`
  }
  return null
}

export function assertExpenseAmounts(a: { net: number; vat: number; gross: number; rate: number }): void {
  const error = expenseAmountsError(a)
  if (error) throw new BadRequestException(error)
}
