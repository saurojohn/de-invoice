/**
 * Tier 457 — Ist-Versteuerung (§ 20 UStG): the output tax on taxed sales is
 * owed in the period the payment arrives (§ 13 Abs. 1 Nr. 1 b UStG), not in
 * the period of the invoice.
 *
 * The payments are walked as for the EÜR (accounting/euer-zufluss.ts, Tier
 * 454): each invoice counts with the part of it paid in the period — a credit
 * note settling it and an overpayment beyond it are no payment of it, an
 * invoice set "paid" without its payments counts the rest at its issue date —
 * and a credit note with the part beyond what it settled (refunded) at its
 * date. The UStVA applies that fraction to each rate of the document.
 *
 * Only taxed sales move: zero-rated ones (§ 4, igL, § 13b, export) are
 * reported at the invoice date either way (igL: § 18a / § 13 Abs. 1 Nr. 6),
 * and the input tax is deducted at the invoice (§ 15).
 */
import { PrismaService } from '../../prisma/prisma.service'
import { euerInflows } from '../accounting/euer-zufluss'

export type Besteuerungsart = 'soll' | 'ist'

export async function besteuerungsart(prisma: PrismaService, companyId: string): Promise<Besteuerungsart> {
  const row = await prisma.company.findUnique({ where: { id: companyId }, select: { besteuerungsart: true } })
  return row?.besteuerungsart === 'ist' ? 'ist' : 'soll'
}

/** The documents paid (or refunded) in the period, with the part paid. */
export async function istPaidDocuments(prisma: PrismaService, companyId: string, start: Date, end: Date) {
  const { inflows } = await euerInflows(prisma, companyId, start, end)
  if (inflows.length === 0) return []
  const docs = await prisma.invoice.findMany({
    where: { companyId, id: { in: inflows.map((f) => f.invoice.id) } },
    include: { items: true },
  })
  const byId = new Map(docs.map((d) => [d.id, d]))
  return inflows
    .map((f) => ({ doc: byId.get(f.invoice.id)!, fraction: f.fraction }))
    .filter((x) => !!x.doc)
}
