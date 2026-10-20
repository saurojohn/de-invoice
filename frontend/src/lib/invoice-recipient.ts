/**
 * Tier 719 — where a customer's invoices go: the address for invoices
 * („E-Mail für Rechnungen“), else the contact's (backend:
 * modules/customer/invoice-recipient.ts).
 */
export function invoiceRecipientOf(customer: { contact?: { email?: string | null; invoiceEmail?: string | null } | null } | null | undefined): string {
  const pick = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  return pick(customer?.contact?.invoiceEmail) || pick(customer?.contact?.email)
}
