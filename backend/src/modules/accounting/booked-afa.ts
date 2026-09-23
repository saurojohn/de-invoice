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

type Db = PrismaClient | Prisma.TransactionClient

export async function bookedAfaCost(db: Db, companyId: string, year: number): Promise<{ amount: number; count: number }> {
  const rows = await db.expense.findMany({
    where: {
      companyId,
      category: 'AfA',
      afaYear: year,
      relatedAssetId: { not: null },
    },
    select: { netAmount: true },
  })
  const cents = rows.reduce((s, r) => s + Math.round(Number(r.netAmount ?? 0) * 100), 0)
  return { amount: -cents / 100, count: rows.length }
}
