/**
 * Tier 438 — the book value of the assets that left the business.
 *
 * Selling or scrapping an asset (`dispose`, Asset.verkauftAm) took it out of
 * the balance sheet and stopped its AfA — and booked nothing else. Its
 * remaining book value (Restbuchwert) vanished: no expense in GuV, BWA, EÜR,
 * Anlage S / G, P&L or DATEV, while the balance sheet lost the asset. Measured:
 * a machine bought for 6 000 € (60 months, January 2025) and sold in June 2026
 * has a book value of 4 200 € at the sale; the GuV 2026 showed its 600 € of
 * AfA and nothing for the 4 200 €.
 *
 * The Restbuchwert is a Betriebsausgabe of the disposal year (§ 4 Abs. 3
 * Satz 4 EStG; in the GuV "sonstige betriebliche Aufwendungen"). The sale
 * price is revenue like any other and comes with the invoice for the sale —
 * `verkaufsPreis` is informational and is not booked here.
 *
 * Computed from the asset register, like the cash-book bookings
 * (cash-bookings.ts): no stored row to go out of step.
 */
import { Prisma, PrismaClient } from '@prisma/client'
import { computeAfaSummary } from './afa'

type Db = PrismaClient | Prisma.TransactionClient

export interface AssetDisposal {
  assetId: string
  bezeichnung: string
  type: string
  date: Date
  /** book value at the disposal: acquisition cost − AfA up to the disposal month */
  restbuchwert: number
  verkaufsPreis: number
}

export async function assetDisposals(db: Db, companyId: string, start: Date, end: Date): Promise<AssetDisposal[]> {
  const assets = await db.asset.findMany({
    where: { companyId, verkauftAm: { gte: start, lte: end } },
    orderBy: { verkauftAm: 'asc' },
  })
  return assets.map((a) => ({
    assetId: a.id,
    bezeichnung: a.bezeichnung,
    type: a.type,
    date: a.verkauftAm!,
    restbuchwert: computeAfaSummary(a, a.verkauftAm!).buchwert,
    verkaufsPreis: Number(a.verkaufsPreis ?? 0),
  }))
}

export function sumRestbuchwert(disposals: AssetDisposal[]): number {
  return Math.round(disposals.reduce((s, d) => s + d.restbuchwert * 100, 0)) / 100
}
