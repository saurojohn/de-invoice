/**
 * Tier 409 — what an invoice owes, per VAT rate, after its discount.
 *
 * Every tax figure used to be built from the stored line amounts, and those
 * are the lines *before* the invoice-level discount (the create path stores
 * quantity × price; EN 16931 means the same by a line's net amount). The
 * discount lives only on the invoice. Measured with one invoice — 1 000 € net,
 * 10 % discount, 19 % VAT, customer pays 1 071 €:
 *
 *   UStVA                 net 1 000, VAT 190        (owed: 900 / 171)
 *   DATEV revenue row     1 000 on 8125, key 0      — the tax-free intra-EU
 *                         account, because 171 / 1 000 = 0.171 is neither 19 %
 *                         nor 7 %; the 100 € discount was never booked, so the
 *                         receivable did not clear
 *   DATEV, a 19 % + 7 % invoice with no discount at all: its blended rate hit
 *                         the same branch — tax-free EU revenue, key 0
 *
 * This module is the one place that answers "how much taxable amount and how
 * much tax, at which rate". It anchors on the invoice's own totals — the
 * document the customer received, whose stated tax is what is owed (§ 14c
 * UStG): net after discount = total − totalVat, tax = totalVat. Only the split
 * across rates comes from the lines, weighted by quantity × price (and by
 * quantity × price × rate for the tax). Parts are rounded to 4 places and the
 * rounding remainder goes to the largest bucket, so they always sum exactly to
 * the document.
 *
 * Signs follow the stored totals: a credit note's buckets are negative.
 * Currency is not converted here; callers apply their EUR factor.
 */

export interface TaxBucket {
  /** VAT rate as a fraction, e.g. 0.19 */
  rate: number
  /** taxable amount after the invoice discount */
  net: number
  vat: number
}

export interface TaxBreakdown {
  net: number
  vat: number
  gross: number
  byRate: TaxBucket[]
}

export interface BreakdownInvoice {
  total: unknown
  totalVat: unknown
  items: Array<{ quantity: unknown; unitPrice: unknown; vatRate: unknown }>
}

const r4 = (n: number) => Math.round(n * 10000) / 10000
const num = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** Split `total` over `weights`, 4 dp, remainder on the largest weight. */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0)
  if (weights.length === 0) return []
  if (sum === 0) {
    // No weight to go by (e.g. every line is 0 %): the whole amount sits on
    // the first bucket rather than vanishing.
    return weights.map((_, i) => (i === 0 ? r4(total) : 0))
  }
  const parts = weights.map((w) => r4((total * w) / sum))
  const drift = r4(total - parts.reduce((s, p) => s + p, 0))
  if (drift !== 0) {
    let largest = 0
    for (let i = 1; i < weights.length; i++) {
      if (Math.abs(weights[i]) > Math.abs(weights[largest])) largest = i
    }
    parts[largest] = r4(parts[largest] + drift)
  }
  return parts
}

export function invoiceTaxBreakdown(inv: BreakdownInvoice): TaxBreakdown {
  const gross = r4(num(inv.total))
  const vat = r4(num(inv.totalVat))
  const net = r4(gross - vat)

  // Undiscounted line value per rate. Absolute values: a credit note stores
  // negative line amounts but positive quantity × price, and its sign comes
  // from the invoice totals above.
  const perRate = new Map<number, number>()
  for (const item of inv.items ?? []) {
    const rate = r4(num(item.vatRate))
    const value = Math.abs(num(item.quantity) * num(item.unitPrice))
    perRate.set(rate, (perRate.get(rate) ?? 0) + value)
  }
  if (perRate.size === 0) {
    const rate = net !== 0 ? r4(vat / net) : 0
    return { net, vat, gross, byRate: [{ rate, net, vat }] }
  }

  const rates = [...perRate.keys()].sort((a, b) => b - a)
  const netWeights = rates.map((r) => perRate.get(r) ?? 0)
  const vatWeights = rates.map((r) => (perRate.get(r) ?? 0) * r)
  const nets = allocate(net, netWeights)
  const vats = allocate(vat, vatWeights)
  return {
    net,
    vat,
    gross,
    byRate: rates.map((rate, i) => ({ rate, net: nets[i], vat: vats[i] })),
  }
}

/**
 * Tier 411 — an invoice's revenue: net, after its discount, in EUR.
 *
 * The income statements (EÜR, Anlage S/G/V, GuV, BWA, the GoBD archive
 * summary) took `eurSubtotal ?? subtotal` — the amount BEFORE the invoice
 * discount. Measured: a 1 000 € invoice with 10 % off, paid 1 071 €, put 1 000
 * on EÜR 4100 and Anlage S 4100 (owed 900). The document's own figures are the
 * anchor, as in invoiceTaxBreakdown: total − totalVat, converted with the
 * EUR amounts computed at issue time when the invoice has them. Signed, so a
 * credit note stays negative.
 */
export interface RevenueInvoice {
  total: unknown
  totalVat: unknown
  eurTotal?: unknown
  eurTotalVat?: unknown
}

export function invoiceNetRevenue(inv: RevenueInvoice): number {
  if (inv.eurTotal != null && inv.eurTotalVat != null) {
    return r4(num(inv.eurTotal) - num(inv.eurTotalVat))
  }
  return r4(num(inv.total) - num(inv.totalVat))
}

/** EUR per unit of the invoice currency, from the amounts stored at issue. */
export function invoiceEurFactor(inv: RevenueInvoice): number {
  const total = num(inv.total)
  if (inv.eurTotal == null || total === 0) return 1
  const f = num(inv.eurTotal) / total
  return Number.isFinite(f) && f > 0 ? f : 1
}
