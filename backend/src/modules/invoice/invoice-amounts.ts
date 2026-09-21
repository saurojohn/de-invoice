/**
 * Tier 415 — an invoice's amounts, in cents, computed once.
 *
 * Invoice amounts were stored to four places and never rounded to cents:
 * 3 × 33,33 € at 19 % was stored as VAT 18,9981 and total 118,9881 while the
 * document the customer received said 19,00 and 118,99. The tax the company
 * owes is the tax stated on the invoice (§ 14c UStG), so every figure that
 * sums stored VAT — UStVA, OSS, DATEV — drifted from what was invoiced, by up
 * to half a cent per invoice. The create, edit, credit-note and recurring
 * paths each had their own copy of the arithmetic (the recurring preview even
 * rounded differently from the run it previewed).
 *
 * The rules are EN 16931's, so the stored amounts are exactly what the
 * XRechnung / ZUGFeRD (computeXRechnungTotals) and the PDF (tax-breakdown.ts)
 * state:
 *   - line net = quantity × unit price, rounded to the cent (BT-131)
 *   - the invoice discount, rounded to the cent, is split across the VAT
 *     rates in proportion to their line nets (largest remainder)
 *   - VAT per rate = that rate's discounted net × rate, rounded to the cent
 *     (BR-CO-17); total VAT = the sum of those — not of per-line VAT
 *   - total = line nets − discount + VAT
 * A line's vatAmount / grossAmount are informational (net × rate, rounded).
 *
 * Signs: a credit note passes negative unit prices, or the caller negates the
 * result; both give the same cents.
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
