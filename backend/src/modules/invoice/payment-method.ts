/**
 * Tier 729 — how the customer pays an invoice.
 *
 * The invoice form offered „Zahlungsart“ (Überweisung, Barzahlung, EC-Karte,
 * Kreditkarte, PayPal) and the service dropped it: every invoice printed a
 * GiroCode and went out as a SEPA transfer (UNTDID 4461 code 58) in its
 * e-invoice, a cash sale included.
 */
export const INVOICE_PAYMENT_METHODS = ['bank_transfer', 'cash', 'ec_card', 'credit_card', 'paypal'] as const
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number]

/** The stored value, or null for a transfer (the default) */
export function storedPaymentMethod(v: string | null | undefined): InvoicePaymentMethod | null {
  return v && v !== 'bank_transfer' && (INVOICE_PAYMENT_METHODS as readonly string[]).includes(v) ? (v as InvoicePaymentMethod) : null
}

/** What the invoice says: „Zahlungsart: Barzahlung“ — nothing for a transfer */
export function paymentMethodLabel(v: string | null | undefined): string | null {
  switch (storedPaymentMethod(v)) {
    case 'cash': return 'Barzahlung'
    case 'ec_card': return 'EC-Karte (girocard)'
    case 'credit_card': return 'Kreditkarte'
    case 'paypal': return 'PayPal'
    default: return null
  }
}
