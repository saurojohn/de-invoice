/**
 * Tier 948 — an amount in the invoice's currency, in euros: the customer's
 * credit is kept in euros (Tier 938). The overage of a credit note on a USD
 * invoice went into it as so many "euros" (595 USD → 595 €).
 */
export function eurOfInvoiceAmount(inv: { currency?: string | null; total?: unknown; eurTotal?: unknown; exchangeRate?: unknown }, amount: number): number {
  if (String(inv.currency || 'EUR').toUpperCase() === 'EUR') return Math.round(amount * 100) / 100
  const total = Number(inv.total)
  if (inv.eurTotal != null && total > 0) return Math.round((amount * Number(inv.eurTotal) / total) * 100) / 100
  const rate = Number(inv.exchangeRate)
  return Math.round((rate > 0 ? amount / rate : amount) * 100) / 100
}
