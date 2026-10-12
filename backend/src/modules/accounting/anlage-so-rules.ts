/**
 * The rules of § 23 EStG (private Veräußerungsgeschäfte) that both Anlage SO
 * services compute with. Read from gesetze-im-internet.de on 10.10.2026.
 *
 * Tier 656 — § 23 Abs. 3 Satz 5: gains stay tax-free when their total in the
 * calendar year is LESS THAN the limit — 1 000 € from 2024 on, 600 € before.
 * It is a Freigrenze, not an allowance: at the limit or above it, the whole
 * gain is taxable. (Before: 600 € for every year, and the page's service
 * subtracted it — 3 000 € of gain were shown as 2 400 € taxable.)
 *
 * Tier 664 — the kinds of asset and their holding periods, § 23 Abs. 1 Satz 1:
 *   Nr. 1  land and rights in land                         ten years
 *   Nr. 2  other assets — gold, art, crypto assets …       one year
 * and securities bought since 2009 are not private sales at all: their gain
 * is capital income whatever the holding period (§ 20 Abs. 2, Anlage KAP).
 * Before: two kinds, "Wertpapier" (one year) and "Sonstige" (ten years) —
 * gold sold after two years was shown as taxable, shares sold after two
 * years as tax-free, and crypto was filed under "Wertpapier" to get its
 * year, so that two lines of the form printed the same sum.
 * Losses of a year are set off against its gains (§ 23 Abs. 3 Satz 7); the
 * page's service did not.
 */
export const freigrenzeFor = (year: number): number => (year >= 2024 ? 1000 : 600)

/** What is taxable of a year's net gain from private sales. */
export const afterFreigrenze = (gain: number, year: number): number =>
  gain > 0 && gain >= freigrenzeFor(year) ? gain : 0

export type VgKind = 'wertpapier' | 'krypto' | 'sonstige' | 'grundstueck'
export const VG_KINDS: VgKind[] = ['krypto', 'sonstige', 'grundstueck', 'wertpapier']

export interface VgRow {
  type?: string | null
  description?: string | null
  acquisitionDate: string
  acquisitionCost: number
  saleDate: string
  salePrice: number
}

const CRYPTO_WORDS =
  /\b(?:BTC|ETH|SOL|XRP|ADA|DOT|AVAX|MATIC|LINK|LTC|BCH|XLM|TRX|DOGE|SHIB|UNI|ATOM|ALGO|XTZ|EOS|XMR|DASH|ETC|NEO|ZEC|USDT|USDC|bitcoin|ethereum|krypto\w*|crypto\w*|token|coin)\b/i

/** A description that names a crypto asset. */
export const looksLikeCrypto = (description: string | null | undefined): boolean =>
  CRYPTO_WORDS.test(String(description || ''))

/**
 * The kind a stored transaction is. Rows from before Tier 664 know only
 * "wertpapier" and "sonstige", and crypto was stored as "wertpapier": such a
 * row whose description names a crypto asset is crypto.
 */
export function kindOf(t: Pick<VgRow, 'type' | 'description'>): VgKind {
  if (t.type === 'krypto' || t.type === 'grundstueck' || t.type === 'sonstige') return t.type
  if (t.type === 'wertpapier') return looksLikeCrypto(t.description) ? 'krypto' : 'wertpapier'
  return 'sonstige'
}

/** The holding period of a kind, in years. */
export const fristYears = (kind: VgKind): number => (kind === 'grundstueck' ? 10 : 1)

/**
 * 'steuerpflichtig'  sold within the period: a private sale
 * 'frei'             sold after it: tax-free
 * 'kap'              a security bought since 2009: capital income, Anlage KAP
 */
export type VgStatus = 'steuerpflichtig' | 'frei' | 'kap'

export function statusOf(t: VgRow): VgStatus {
  const kind = kindOf(t)
  if (kind === 'wertpapier' && String(t.acquisitionDate).slice(0, 10) >= '2009-01-01') return 'kap'
  // "nicht mehr als ein Jahr / zehn Jahre": the day the period ends still counts
  const a = new Date(`${String(t.acquisitionDate).slice(0, 10)}T00:00:00Z`)
  const end = new Date(Date.UTC(a.getUTCFullYear() + fristYears(kind), a.getUTCMonth(), a.getUTCDate()))
  const sale = new Date(`${String(t.saleDate).slice(0, 10)}T00:00:00Z`)
  return sale.getTime() <= end.getTime() ? 'steuerpflichtig' : 'frei'
}

const r2 = (n: number): number => Math.round(n * 100) / 100

export interface VgSummary {
  /** gains and losses of the sales within their period */
  gain: number
  loss: number
  /** gains less losses of the year, less a loss carried forward; never below 0 */
  net: number
  /** what is left of the losses when the gains do not cover them */
  carryforward: number
  freigrenze: number
  freigrenzeApplied: boolean
  /** taxable: 0 below the limit, else the whole net gain */
  taxable: number
  countTaxable: number
  countFree: number
  /** securities bought since 2009 — not part of this form */
  countKap: number
  gainKap: number
  /** per kind: the gains of the sales within their period (the form's lines) */
  gainByKind: Record<VgKind, number>
  countByKind: Record<VgKind, number>
}

export function vgSummary(rows: VgRow[], year: number, priorLoss = 0): VgSummary {
  const gainByKind: Record<VgKind, number> = { krypto: 0, sonstige: 0, grundstueck: 0, wertpapier: 0 }
  const countByKind: Record<VgKind, number> = { krypto: 0, sonstige: 0, grundstueck: 0, wertpapier: 0 }
  let gain = 0, loss = 0, countTaxable = 0, countFree = 0, countKap = 0, gainKap = 0
  for (const t of rows) {
    const kind = kindOf(t)
    const status = statusOf(t)
    const g = Number(t.salePrice) - Number(t.acquisitionCost)
    countByKind[kind]++
    if (status === 'kap') { countKap++; gainKap += g; continue }
    if (status === 'frei') { countFree++; continue }
    countTaxable++
    if (g > 0) { gain += g; gainByKind[kind] += g } else loss += -g
  }
  const net = Math.max(0, gain - loss - Math.max(0, priorLoss))
  const carryforward = Math.max(0, loss + Math.max(0, priorLoss) - gain)
  const taxable = afterFreigrenze(net, year)
  for (const k of VG_KINDS) gainByKind[k] = r2(gainByKind[k])
  return {
    gain: r2(gain), loss: r2(loss), net: r2(net), carryforward: r2(carryforward),
    freigrenze: freigrenzeFor(year), freigrenzeApplied: net > 0 && taxable === 0 || (net === 0 && countTaxable > 0),
    taxable: r2(taxable), countTaxable, countFree, countKap, gainKap: r2(gainKap), gainByKind, countByKind,
  }
}
