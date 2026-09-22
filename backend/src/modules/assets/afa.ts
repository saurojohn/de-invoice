/**
 * Tier 427 — linear AfA (§ 7 Abs. 1 EStG), in calendar months.
 *
 * AfA runs pro rata temporis by month: the month an asset is acquired counts
 * in full, and so does the month it is sold (R 7.4 EStR). The day of the
 * month never matters.
 *
 * It used to: the month count was "the months between the two dates, plus one
 * if the later date's day-of-month is at least the earlier one's". Measured
 * on an asset acquired 10 January 2025 for 6 000 € over 60 months and sold on
 * 5 June 2026: 17 months of AfA instead of 18 (Jan 2025 – Jun 2026), so its
 * book value at disposal was 4 300 € instead of 4 200 €. An asset acquired on
 * 31 March 2026 over 36 months was given 300 € of AfA in 2029 although only
 * two months (Jan, Feb) were left of its useful life — 200 €.
 *
 * There were two implementations, and they disagreed: Anlage V's copy left
 * out the correction that stops January of the year being counted twice, so
 * in an asset's final year it charged one month less than the asset register
 * and the balance sheet did. This module is the only one now.
 */

export interface AfaAsset {
  id?: string
  anschaffungsKosten: any
  restwert: any
  nutzungsdauerMonate: number
  anschaffungsDatum: Date
  verkauftAm: Date | null
}

export interface AfaSummary {
  assetId: string
  anschaffungsKosten: number
  restwert: number
  monthlyAfA: number
  /** calendar months from the acquisition month to the snapshot month, both included */
  monthsHeld: number
  accumulatedAfA: number
  buchwert: number
  annualAfA: number
  disposed: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Calendar months from `from` to `to`, both months included; 0 when `to` is before `from`. */
export function afaMonths(from: Date, to: Date): number {
  if (to < from) return 0
  const years = to.getFullYear() - from.getFullYear()
  const months = to.getMonth() - from.getMonth()
  return Math.max(0, years * 12 + months + 1)
}

export function computeAfaSummary(asset: AfaAsset, snapshot: Date): AfaSummary {
  const ak = Number(asset.anschaffungsKosten)
  const restwert = Number(asset.restwert)
  const nd = asset.nutzungsdauerMonate
  const depreciable = Math.max(0, ak - restwert)
  const monthlyAfA = nd > 0 ? depreciable / nd : 0

  // A disposed asset stops depreciating in the month it was sold.
  const effectiveEnd =
    asset.verkauftAm && asset.verkauftAm <= snapshot ? asset.verkauftAm : snapshot

  const monthsHeld = Math.min(afaMonths(asset.anschaffungsDatum, effectiveEnd), nd)
  const accumulatedAfA = Math.min(round2(monthsHeld * monthlyAfA), depreciable)
  const buchwert = round2(ak - accumulatedAfA)

  // The AfA of the snapshot's calendar year: the months the asset is held in
  // that year, capped at what is left of its useful life at the year's start.
  const year = snapshot.getFullYear()
  const yearStart = new Date(year, 0, 1)
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)
  const start = asset.anschaffungsDatum > yearStart ? asset.anschaffungsDatum : yearStart
  const disposalEnd =
    asset.verkauftAm && asset.verkauftAm < yearEnd ? asset.verkauftAm : yearEnd
  const end = disposalEnd < yearEnd ? disposalEnd : yearEnd
  // Months before this year: afaMonths counts the year's January as well, so
  // one month comes off.
  const monthsBeforeYear = Math.min(
    Math.max(0, afaMonths(asset.anschaffungsDatum, yearStart) - 1),
    nd,
  )
  const remainingNd = Math.max(0, nd - monthsBeforeYear)
  const monthsInYear = start <= end ? Math.min(afaMonths(start, end), remainingNd) : 0
  const annualAfA = round2(monthsInYear * monthlyAfA)

  return {
    assetId: asset.id ?? '',
    anschaffungsKosten: round2(ak),
    restwert: round2(restwert),
    monthlyAfA: round2(monthlyAfA),
    monthsHeld,
    accumulatedAfA: round2(accumulatedAfA),
    buchwert,
    annualAfA,
    disposed: !!asset.verkauftAm,
  }
}
