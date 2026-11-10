/**
 * Tier 436 — the AfA booked for a year, as a cost (a positive amount).
 *
 * "AfA buchen" (Tier 87) stores each asset's AfA as an Expense row with
 * category 'AfA' and a NEGATIVE netAmount. GuV, BWA and Anlage G handle the
 * sign; the two § 4 Abs. 3 forms did not. Measured with one asset and 1 200 €
 * of AfA booked for the year: the EÜR left the AfA out entirely (Gewinn 0),
 * and Anlage S put −1 200 € into its 4600 line and subtracted that from the
 * revenue — its Gewinn was +1 200 €, the depreciation raising the profit.
 * GuV, BWA and Anlage G said −1 200 €.
 */
import { Prisma, PrismaClient } from '@prisma/client'
import { computeAfaSummary } from '../assets/afa'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Tier 746 — an AfA row that stands. The AfA storno leaves the booking in the
 * ledger and adds its counter-entry, and marks both: in every sum the pair is
 * zero, and "is this year booked?" looks only at rows without the mark.
 */
export const LIVE_AFA = { afaReversedAt: null } as const

export async function bookedAfaCost(db: Db, companyId: string, year: number): Promise<{ amount: number; count: number }> {
  const rows = await db.expense.findMany({
    where: {
      companyId,
      category: 'AfA',
      afaYear: year,
      relatedAssetId: { not: null },
      ...LIVE_AFA,
    },
    select: { netAmount: true },
  })
  const cents = rows.reduce((s, r) => s + Math.round(Number(r.netAmount ?? 0) * 100), 0)
  return { amount: -cents / 100, count: rows.length }
}

/**
 * Tier 437 — an AfA row is a booking, not a supplier invoice.
 *
 * `relatedAssetId` is set on the rows "AfA buchen" creates and nowhere else.
 * Reports about bills and money — payables, cash flow, the dashboard, cost
 * centres, the DATEV Kreditor rows — took them for a supplier invoice with a
 * negative amount. Measured with 1 200 € of AfA booked and nothing else: the
 * balance sheet owed suppliers −1 200 €, the cash-flow forecast showed
 * +1 200 € coming in, the dashboard's open payables were −1 200 €, and DATEV
 * got "Kreditor 70000 an 4900" — a supplier credit reducing expenses.
 */
export const NOT_AFA_BOOKING = { relatedAssetId: null } as const

/**
 * Tier 830 — the computed AfA of a window inside one calendar year: each
 * asset's AfA of that year spread over the months it is depreciated in that
 * year (Tier 800: from the month of acquisition, until the month of sale or
 * the end of its useful life), counted for the window's months.
 *
 * It was the year's AfA × the window's months / 12 (the BWA's rule since
 * Tier 86, made shared in Tier 824): spread over all twelve months, whether
 * the asset was there or not. Measured in the month-end drill (a laptop of
 * 1 100 € over 36 months, bought 24.10.2026): the BWA's October carried
 * 7,64 € of AfA — the year's 91,67 € / 12 — instead of 30,56 €, and
 * January to September 7,64 € each for a laptop not yet bought.
 */
export function computedAfaInWindow(assets: Parameters<typeof computeAfaSummary>[0][], start: Date, end: Date): number {
  if (end < start) return 0
  const year = start.getFullYear()
  const firstWindowMonth = start.getMonth() + 1
  const lastWindowMonth = end.getFullYear() > year ? 12 : end.getMonth() + 1
  let cents = 0
  for (const a of assets) {
    const s = computeAfaSummary(a, new Date(year, 11, 31, 23, 59, 59, 999))
    if (s.monthsInYear <= 0 || s.annualAfA <= 0) continue
    const from = Math.max(firstWindowMonth, s.firstMonthInYear)
    const to = Math.min(lastWindowMonth, s.firstMonthInYear + s.monthsInYear - 1)
    if (to < from) continue
    // cumulative, so that the months add up to the year's AfA to the cent
    // (91,67 over three months: 30,56 + 30,55 + 30,56, not 3 × 30,56 = 91,68)
    const upTo = (m: number) => Math.round((s.annualAfA * Math.max(0, m - s.firstMonthInYear + 1) / s.monthsInYear) * 100)
    cents += upTo(to) - upTo(from - 1)
  }
  return cents / 100
}

/**
 * Tier 824 — the AfA of a period, as a cost, by one rule for the dashboard,
 * the monthly P&L and the BWA: the year's AfA bookings that stand, when it
 * has any (an annual booking falls on 31.12., a monthly one on each month's
 * end), else the AfA computed from the asset register, pro rata — as the
 * BWA has done since Tier 86 and the GuV for the year.
 *
 * Measured before (an asset of 12 000 € over 60 months, AfA booked monthly,
 * on 10.11.): the dashboard took every AfA row with Math.abs — after „AfA
 * stornieren" the booking and its counter-entry (Tier 746) both counted, its
 * „Gewinn YTD" fell from −2 000 to −4 000, and to −6 000 when booked again;
 * the BWA's 3100 went 2 200 → 4 400 → 6 600. Without a booking the
 * dashboard and the P&L had no AfA at all, the BWA and the GuV the computed.
 *
 * Loads the year once; `cost(start, end, months)` for a window inside it
 * (`months`: its length, for the computed share).
 */
export async function afaOfYear(db: Db, companyId: string, year: number) {
  const [rows, assets] = await Promise.all([
    db.expense.findMany({
      where: { companyId, category: 'AfA', afaYear: year, relatedAssetId: { not: null }, ...LIVE_AFA },
      select: { netAmount: true, invoiceDate: true },
    }),
    db.asset.findMany({ where: { companyId } }),
  ])
  const booked = rows.reduce((s, r) => s + Math.round(Number(r.netAmount ?? 0) * 100), 0) !== 0
  return {
    booked,
    cost(start: Date, end: Date, months: number): number {
      if (booked) {
        const cents = rows
          .filter((r) => r.invoiceDate >= start && r.invoiceDate <= end)
          .reduce((s, r) => s - Math.round(Number(r.netAmount ?? 0) * 100), 0)
        return cents / 100
      }
      void months
      return computedAfaInWindow(assets, start, end)
    },
  }
}
