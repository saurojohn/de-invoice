/**
 * Tier 704 — an amount as a German page writes it: 1.190,00 € (or
 * 2.380,00 USD in another currency). The invoice list, the invoice page, the
 * Raten, a bank line and a voucher wrote "€535.50" / "1190.00 €" — the English
 * decimal point, no thousands separator — while the form, the reports and the
 * PDF write 535,50 €.
 */
export function formatMoney(value: number | string | null | undefined, currency = "EUR"): string {
  const n = Number(value) || 0
  const code = String(currency || "EUR").toUpperCase()
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: code,
      currencyDisplay: code === "EUR" ? "symbol" : "code",
    }).format(n)
  } catch {
    // not an ISO currency code
    return `${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`
  }
}
