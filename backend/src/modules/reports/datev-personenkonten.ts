/**
 * Tier 423 — DATEV Personenkonten.
 *
 * DATEV books an invoice on the customer's own account (Debitor), not on the
 * collective receivables account: the Berater's open-item list, dunning and
 * the balance per customer all hang off it. Before this tier every invoice
 * was booked on 1406 (a Sachkonto), so none of that worked after import.
 *
 * With 4-digit Sachkonten (SKR03/SKR04) the Personenkonten have 5 digits:
 *   Debitoren  10000–69999
 *   Kreditoren 70000–99999, 70000 kept for expenses without a supplier
 *              ("Diverse Kreditoren")
 *
 * A number is assigned on the first export that needs it and stored on the
 * customer / supplier, so every later export uses the same account. Numbers
 * continue after the highest one the company already has; a concurrent export
 * that takes the same number loses on the unique index and retries.
 */
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'

export const DEBITOR_FIRST = 10000
export const DEBITOR_LAST = 69999
export const DIVERSE_KREDITOREN = 70000
export const KREDITOR_FIRST = 70001
export const KREDITOR_LAST = 99999

type Kind = 'customer' | 'supplier'

async function highest(prisma: PrismaService, kind: Kind, companyId: string, first: number, last: number) {
  const where = { companyId, datevAccount: { gte: first, lte: last } }
  const agg = kind === 'customer'
    ? await prisma.customer.aggregate({ where, _max: { datevAccount: true } })
    : await prisma.supplier.aggregate({ where, _max: { datevAccount: true } })
  return agg._max.datevAccount ?? first - 1
}

/**
 * The DATEV account of every given customer or supplier, assigning one to
 * those that have none yet. Returns id → account number.
 */
export async function ensurePersonenkonten(
  prisma: PrismaService,
  kind: Kind,
  companyId: string,
  ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return out
  const where = { companyId, id: { in: unique } }
  const select = { id: true, datevAccount: true, createdAt: true }
  const rows = kind === 'customer'
    ? await prisma.customer.findMany({ where, select, orderBy: { createdAt: 'asc' } })
    : await prisma.supplier.findMany({ where, select, orderBy: { createdAt: 'asc' } })
  const [first, last] = kind === 'customer' ? [DEBITOR_FIRST, DEBITOR_LAST] : [KREDITOR_FIRST, KREDITOR_LAST]

  for (const r of rows) {
    if (r.datevAccount != null) {
      out.set(r.id, r.datevAccount)
      continue
    }
    for (let attempt = 0; ; attempt++) {
      const next = (await highest(prisma, kind, companyId, first, last)) + 1
      if (next > last) {
        throw new Error(`Keine freie DATEV-Kontonummer mehr (${first}–${last})`)
      }
      try {
        // Only if still unassigned — a concurrent export may have given this
        // customer a number in the meantime.
        const data = { datevAccount: next }
        const whereFree = { id: r.id, companyId, datevAccount: null }
        const res = kind === 'customer'
          ? await prisma.customer.updateMany({ where: whereFree, data })
          : await prisma.supplier.updateMany({ where: whereFree, data })
        if (res.count === 0) {
          const again = kind === 'customer'
            ? await prisma.customer.findUnique({ where: { id: r.id }, select: { datevAccount: true } })
            : await prisma.supplier.findUnique({ where: { id: r.id }, select: { datevAccount: true } })
          out.set(r.id, again!.datevAccount!)
        } else {
          out.set(r.id, next)
        }
        break
      } catch (e) {
        const taken = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
        if (!taken || attempt >= 20) throw e
      }
    }
  }
  return out
}
