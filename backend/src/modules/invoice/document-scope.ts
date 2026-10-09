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
 * Tier 472: nor the advance a final invoice deducts ('Anzahlung', advance.ts)
 * — the money arrived as the Proforma's payment.
 */
export const NON_CASH_PAYMENT_METHODS = ['Gutschrift', 'Guthaben', 'Anzahlung']

/**
 * Tier 610 — documents that are no invoices: a quote (QU, „Angebot“, numbered
 * AN-…) and a delivery note (DN, „Lieferschein“, LS-…). They live in the same
 * table and share the editor and the PDF, and that is all: no claim, no VAT,
 * no payment, no credit note, no stock movement, no e-invoice, no period lock.
 * Every report selects by SALES_TYPES / CLAIM_TYPES, so they are in none.
 * And they have statuses of their own, so nothing that asks for "sent" or
 * "paid" documents (bank matching, direct debit, reminders) meets them:
 *   quote          draft → offered → accepted | declined;   → cancelled
 *   delivery note  draft → delivered;                        → cancelled
 */
// Tier 614: and the order confirmation (OC → AB-…) between the quote and the invoice:
//   order confirmation  draft → confirmed;               → cancelled
export const NON_FISCAL_TYPES = ['QU', 'DN', 'OC']
export const isNonFiscal = (type: string | null | undefined): boolean => NON_FISCAL_TYPES.includes(String(type))
export const NON_FISCAL_STATUSES = ['offered', 'accepted', 'declined', 'delivered', 'confirmed']
export const NON_FISCAL_TRANSITIONS: Record<string, Record<string, string[]>> = {
  QU: { draft: ['offered', 'cancelled'], offered: ['accepted', 'declined', 'cancelled'], accepted: ['cancelled'], declined: [], cancelled: [] },
  DN: { draft: ['delivered', 'cancelled'], delivered: ['cancelled'], cancelled: [] },
  OC: { draft: ['confirmed', 'cancelled'], confirmed: ['cancelled'], cancelled: [] },
}
export const DOCUMENT_NAMES: Record<string, string> = {
  INV: 'Rechnung', CN: 'Gutschrift', PI: 'Proforma-Rechnung', RCV: 'Quittung', QU: 'Angebot', DN: 'Lieferschein', OC: 'Auftragsbestätigung',
}
/** the status a non-fiscal document has once it has gone out */
export const ISSUED_AS: Record<string, string> = { QU: 'offered', DN: 'delivered', OC: 'confirmed' }
