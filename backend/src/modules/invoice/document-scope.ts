/**
 * Tier 424 — which documents count where.
 *
 * The invoice table holds four document types:
 *   INV  Rechnung
 *   RCV  Quittung — a sale settled on the spot; it has line items and VAT
 *   CN   Gutschrift / Rechnungskorrektur — negative amounts
 *   PI   Proforma-Rechnung — a request for advance payment, not an invoice
 *        in the sense of § 14 UStG: no revenue, no tax, no receivable
 *
 * Measured before this tier (one sent PI and one sent RCV, 1 000 net each):
 * the UStVA declared the PI's 190 € and not the RCV's; GuV, BWA, Anlage S and
 * the EÜR-style reports counted both as revenue (2 000); the ageing report and
 * the customer's open balance listed the PI as owed; the dashboard counted
 * drafts and cancelled documents too.
 */

/** Issued documents: not a draft, not cancelled. */
export const ISSUED_STATUSES = ['sent', 'paid', 'overdue']

/** Documents that carry revenue and VAT (a credit note negatively). */
export const SALES_TYPES = ['INV', 'RCV', 'CN']

/** Documents a customer can owe money on. */
export const CLAIM_TYPES = ['INV', 'RCV']

/**
 * Tier 431 — payments that are not money arriving: a credit note settling
 * its invoice ('Gutschrift', booked by createCreditNote) and a customer
 * credit applied to an invoice ('Guthaben' — the cash came in once, as the
 * overpayment that created the credit). They reduce what is open; they are
 * no bank or cash receipt. DATEV exported 'Guthaben' as a second receipt of
 * the same money, and the customer statement deducted the credit twice.
 */
export const NON_CASH_PAYMENT_METHODS = ['Gutschrift', 'Guthaben']
