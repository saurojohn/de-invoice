/**
 * Tier 415 — the invoice form's live totals, by the backend's rules.
 *
 * A copy of backend/src/modules/invoice/invoice-amounts.ts (the frontend is a
 * separate package). The form used to add VAT on the *undiscounted* lines:
 * 1 000 € at 10 % off showed VAT 190,00 and a total of 1 090,00, and the
 * invoice it then created said 171,00 / 1 071,00. Keep the two files in step;
 * backend e2e spec 204 compares them.
 */

export interface AmountLine {
  quantity: number
  unitPrice: number
  vatRate: number
}

export interface InvoiceAmounts {
  lines: Array<{ net: number; vat: number; gross: number }>
  /** sum of line nets, before the invoice discount */
  subtotal: number
  /** the invoice discount in money (positive for a reduction) */
  discountAmount: number
  byRate: Array<{ rate: number; net: number; vat: number }>
  totalVat: number
  total: number
}

/** Round to cents, half away from zero, robust to binary noise (1,005 → 1,01). */
export function toCents(amount: number): number {
  const abs = Math.abs(amount) * 100
  const cents = Math.round(Number(abs.toFixed(6)))
  return amount < 0 ? -cents : cents
}

const eur = (cents: number) => cents / 100

/** Split `total` cents over `weights`; the remainder goes to the largest weight. */
function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0))
  const parts = weights.map((w) => Math.round((total * w) / sum))
  const drift = total - parts.reduce((a, b) => a + b, 0)
  if (drift !== 0) {
    let largest = 0
    for (let i = 1; i < weights.length; i++) if (Math.abs(weights[i]) > Math.abs(weights[largest])) largest = i
    parts[largest] += drift
  }
  return parts
}

export function computeInvoiceAmounts(
  items: AmountLine[],
  discount: { discountPercent?: number | null; discountAmount?: number | null } = {},
): InvoiceAmounts {
  const lineNets = items.map((i) => toCents(Number(i.quantity) * Number(i.unitPrice)))
  const subtotal = lineNets.reduce((a, b) => a + b, 0)

  const pct = Number(discount.discountPercent ?? 0)
  const discountCents =
    pct > 0 ? toCents((eur(subtotal) * pct) / 100) : toCents(Number(discount.discountAmount ?? 0))

  const rates: number[] = []
  const netByRate = new Map<number, number>()
  items.forEach((item, i) => {
    const r = Math.round(Number(item.vatRate) * 10000) / 10000
    if (!netByRate.has(r)) rates.push(r)
    netByRate.set(r, (netByRate.get(r) ?? 0) + lineNets[i])
  })
  rates.sort((a, b) => b - a)
  const taxable = allocate(
    subtotal - discountCents,
    rates.map((r) => netByRate.get(r) ?? 0),
  )
  const byRate = rates.map((rate, i) => ({
    rate,
    net: taxable[i],
    vat: toCents(eur(taxable[i]) * rate),
  }))
  const totalVat = byRate.reduce((a, b) => a + b.vat, 0)

  return {
    lines: items.map((item, i) => {
      const vat = toCents(eur(lineNets[i]) * Number(item.vatRate))
      return { net: eur(lineNets[i]), vat: eur(vat), gross: eur(lineNets[i] + vat) }
    }),
    subtotal: eur(subtotal),
    discountAmount: eur(discountCents),
    byRate: byRate.map((b) => ({ rate: b.rate, net: eur(b.net), vat: eur(b.vat) })),
    totalVat: eur(totalVat),
    total: eur(subtotal - discountCents + totalVat),
  }
}
