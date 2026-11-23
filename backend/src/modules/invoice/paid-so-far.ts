import { PrismaService } from '../../prisma/prisma.service'

/** Tier 946: what an invoice's payments come to so far (in its currency) */
export async function paidSoFar(db: Pick<PrismaService, 'payment'>, invoiceId: string): Promise<number> {
  const r = await db.payment.aggregate({ where: { invoiceId }, _sum: { amount: true } })
  return Number(r._sum.amount ?? 0)
}
