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
 *
 * Tier 665 — what is entered stays, and nothing is counted that is not known.
 * A row whose sale was in another year, or had no sale date yet, was saved
 * and then left out of the answer: the form no longer showed it and its next
 * save deleted it. A row without an acquisition date counted as tax-free, a
 * sale before its acquisition as taxable. `splitRows` gives every stored row
 * back, with what it counts as or why it is not counted.
 * A row saved since Tier 664 carries `v: 2`: its kind is the one chosen. Only
 * a row from before is read by its description (crypto filed as a security) —
 * a "Bitcoin ETF" entered as a security stays one.
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
  /** 2: saved with the four kinds — the kind is the one chosen */
  v?: number
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
export function kindOf(t: Pick<VgRow, 'type' | 'description' | 'v'>): VgKind {
  if (t.type === 'krypto' || t.type === 'grundstueck' || t.type === 'sonstige') return t.type
  if (t.type === 'wertpapier') return t.v !== 2 && looksLikeCrypto(t.description) ? 'krypto' : 'wertpapier'
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

/** Why a row is not counted in a year. */
export type VgProblem = 'saleDate' | 'otherYear' | 'acquisitionDate' | 'saleBeforeAcquisition'

const YMD = /^\d{4}-\d{2}-\d{2}$/
const ymd = (v: unknown): string => (typeof v === 'string' && YMD.test(v) ? v : '')

export function problemOf(t: Pick<VgRow, 'acquisitionDate' | 'saleDate'>, year: number): VgProblem | null {
  if (!ymd(t.saleDate)) return 'saleDate'
  if (Number(t.saleDate.slice(0, 4)) !== year) return 'otherYear'
  if (!ymd(t.acquisitionDate)) return 'acquisitionDate'
  if (t.saleDate < t.acquisitionDate) return 'saleBeforeAcquisition'
  return null
}

export interface VgMetadata { importedFromExpenseId?: string; importedAt?: string }
export interface VgClean extends VgRow {
  type: VgKind
  description: string
  v: 2
  metadata?: VgMetadata
}
export interface VgListed extends VgClean {
  /** what the row counts as — null when it is not counted */
  status: VgStatus | null
  problem: VgProblem | null
}

/** A stored row in the one shape both services and the save work with. */
export function cleanRow(t: any, keepKind = false): VgClean {
  const description = String(t?.description || '').trim()
  const type = kindOf({ type: t?.type, description, v: keepKind ? 2 : t?.v })
  const m = t?.metadata && typeof t.metadata === 'object' ? t.metadata : null
  const metadata: VgMetadata | undefined =
    m && typeof m.importedFromExpenseId === 'string'
      ? { importedFromExpenseId: m.importedFromExpenseId, ...(typeof m.importedAt === 'string' ? { importedAt: m.importedAt } : {}) }
      : undefined
  return {
    type,
    description,
    acquisitionDate: ymd(t?.acquisitionDate),
    acquisitionCost: Number(t?.acquisitionCost) || 0,
    saleDate: ymd(t?.saleDate),
    salePrice: Number(t?.salePrice) || 0,
    v: 2,
    ...(metadata ? { metadata } : {}),
  }
}

/**
 * The rows stored for a year: `rows` is every one of them, in the order they
 * were entered; `counted` the sales of the year that are complete.
 */
export function splitRows(raw: unknown, year: number): { counted: VgClean[]; rows: VgListed[] } {
  const rows: VgListed[] = (Array.isArray(raw) ? raw : [])
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const row = cleanRow(t)
      const problem = problemOf(row, year)
      return { ...row, status: problem ? null : statusOf(row), problem }
    })
  const counted = rows.filter((r) => !r.problem).map(({ status: _s, problem: _p, ...row }) => row)
  return { counted, rows }
}

const KIND_DE: Record<VgKind, string> = { wertpapier: 'Wertpapier', krypto: 'Kryptowert', sonstige: 'Sonstiges', grundstueck: 'Grundstück' }
const de = (ymdDate: string): string => (ymdDate ? `${ymdDate.slice(8, 10)}.${ymdDate.slice(5, 7)}.${ymdDate.slice(0, 4)}` : '—')
const eur = (n: number): string => new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)

/** One row as a line of the preview's PDF — the same in both documents. */
export function rowLine(t: VgListed): string {
  const head =
    `• [${KIND_DE[t.type]}] ${t.description || '(ohne Beschreibung)'} — ` +
    `Anschaffung ${de(t.acquisitionDate)} (${eur(t.acquisitionCost)} €) → Veräußerung ${de(t.saleDate)} (${eur(t.salePrice)} €)`
  if (t.problem === 'saleDate') return `${head} [nicht angesetzt: Veräußerungsdatum fehlt]`
  if (t.problem === 'otherYear') return `${head} [nicht angesetzt: veräußert ${t.saleDate.slice(0, 4)} — gehört in die Anlage SO ${t.saleDate.slice(0, 4)}]`
  if (t.problem === 'acquisitionDate') return `${head} [nicht angesetzt: Anschaffungsdatum fehlt — die Frist lässt sich nicht bestimmen]`
  if (t.problem === 'saleBeforeAcquisition') return `${head} [nicht angesetzt: Veräußerung vor der Anschaffung]`
  const gain = t.salePrice - t.acquisitionCost
  const result = `= ${eur(gain)} € ${gain >= 0 ? 'Gewinn' : 'Verlust'}`
  if (t.status === 'kap') return `${head} ${result} [seit 2009 angeschafft — Anlage KAP, hier nicht angesetzt]`
  const frist = fristYears(t.type) === 10 ? 'zehn Jahre' : 'ein Jahr'
  return `${head} ${result} [Frist ${frist}: ${t.status === 'steuerpflichtig' ? 'innerhalb — steuerpflichtig' : 'abgelaufen — steuerfrei'}]`
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
