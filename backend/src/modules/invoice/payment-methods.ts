import { BadRequestException } from '@nestjs/common'

/**
 * Tier 514 / 525 — payment methods the system books itself.
 *
 * 'Gutschrift' (a credit note settling its invoice) and 'Guthaben' (credit
 * applied to an invoice) count as "no money arrived" (document-scope.ts).
 * Entered by hand they mark an invoice paid with no credit note and without
 * touching the customer's credit. Tier 514 refused them on
 * `POST /invoices/:id/payments` only; measured afterwards, the customer's
 * "Zahlung verteilen", a Rate of a Ratenplan and a booked Zahlungsmeldung
 * still took them. Every route where a person names the method calls this.
 * ('Anzahlung' is refused in PaymentService.create.)
 */
export function assertManualPaymentMethod(method: unknown): void {
  const m = String(method ?? '').trim().toLowerCase()
  if (m === 'gutschrift') {
    throw new BadRequestException(
      'Der Zahlungsweg „Gutschrift“ wird beim Erstellen einer Gutschrift gebucht, nicht von Hand — bitte „Gutschrift“ an der Rechnung verwenden.',
    )
  }
  if (m === 'guthaben') {
    throw new BadRequestException(
      'Der Zahlungsweg „Guthaben“ wird beim Verrechnen von Kundenguthaben gebucht, nicht von Hand — bitte „Guthaben verrechnen“ beim Kunden verwenden.',
    )
  }
}
