/**
 * Tier 719 — where a customer's invoices go: the address for invoices
 * („E-Mail für Rechnungen“, e.g. the accounts department), else the contact's.
 *
 * A customer had one e-mail address, its contact's; invoices, reminders,
 * statements and the invoices of a recurring template went there. Many firms
 * take invoices at an address of their own (buchhaltung@, rechnungen@ — some
 * insist on it). Kept in the contact JSON (`contact.invoiceEmail`).
 */
export function invoiceRecipientOf(customer: { contact?: unknown } | null | undefined): string {
  const contact = (customer?.contact ?? {}) as { email?: unknown; invoiceEmail?: unknown }
  const pick = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return pick(contact.invoiceEmail) || pick(contact.email)
}
