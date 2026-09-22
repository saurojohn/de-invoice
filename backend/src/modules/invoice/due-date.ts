/**
 * Tier 428 — the due date of an invoice.
 *
 * The payment term comes from the most specific place that has one: the
 * invoice's own "Zahlungsziel", else the customer's, else the company's
 * default. 0 days is a term ("sofort fällig"), not a missing value — only
 * when nothing at all is set does an invoice go out without a due date.
 *
 * Measured before: the invoice form's Zahlungsziel select went nowhere (the
 * DTO accepted `paymentTerms` and the service dropped it — there is no such
 * column), the customer's own `paymentTerms` was never read, and every
 * invoice got the company default. A customer on 14 days was billed with
 * 30, and the dunning ran two weeks late. Recurring invoices had 30 days
 * hard-coded, whatever the customer or the company said.
 */

const DAY = 86_400_000

export function resolvePaymentTermDays(
  invoiceTerms: number | null | undefined,
  customerTerms: number | null | undefined,
  companyDays: number | null | undefined,
): number | null {
  for (const candidate of [invoiceTerms, customerTerms, companyDays]) {
    if (candidate === null || candidate === undefined) continue
    const n = Number(candidate)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}

/** The due date, or null when no term is configured anywhere. */
export function resolveDueDate(
  issueDate: Date,
  explicit: Date | null | undefined,
  invoiceTerms: number | null | undefined,
  customerTerms: number | null | undefined,
  companyDays: number | null | undefined,
): Date | null {
  if (explicit) return explicit
  const days = resolvePaymentTermDays(invoiceTerms, customerTerms, companyDays)
  return days === null ? null : new Date(issueDate.getTime() + days * DAY)
}
