/**
 * Tier 503 — business gifts (Geschenke an Geschäftsfreunde).
 *
 * § 4 Abs. 5 Nr. 1 EStG: gifts to people who are not employees are a
 * Betriebsausgabe only if all gifts to that recipient in the year cost no
 * more than 50 € (net; gross for a business without input-tax deduction).
 * Above it, every gift to the recipient is non-deductible — and so is its
 * input tax (§ 15 Abs. 1a UStG). The recipient's name has to be recorded
 * (§ 4 Abs. 7 EStG); without it only a Streuartikel (≤ 10 €) passes.
 *
 * Gifts (an expense whose category starts with "Geschenk") were treated as
 * any expense: deducted in full, the input tax claimed. Here: the gifts
 * that do not qualify, so EÜR / Anlage S / G, the UStVA and KSt 1 can leave
 * them out (and show them).
 */
import { expenseCost } from './expense-cost'

export const GIFT_LIMIT = 50
export const STREUARTIKEL_LIMIT = 10

export function isGeschenk(e: { category?: string | null }): boolean {
  return /^Geschenk/i.test(e.category || '')
}

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ')

type GiftRow = {
  id: string
  invoiceDate: Date
  netAmount: unknown
  grossAmount: unknown
  giftRecipient: string | null
}

/** The non-deductible ones among a year's gifts (pure; for one company). */
export function nonDeductibleGifts(gifts: GiftRow[], kleinunternehmer: boolean): Set<string> {
  const out = new Set<string>()
  const byRecipient = new Map<string, GiftRow[]>()
  for (const g of gifts) {
    const cost = expenseCost(g as any, kleinunternehmer)
    const who = norm(g.giftRecipient)
    if (!who) {
      // No recipient recorded: only a Streuartikel.
      if (cost > STREUARTIKEL_LIMIT) out.add(g.id)
      continue
    }
    const key = `${new Date(g.invoiceDate).getFullYear()}|${who}`
    byRecipient.set(key, [...(byRecipient.get(key) ?? []), g])
  }
  for (const list of byRecipient.values()) {
    const total = list.reduce((s, g) => s + expenseCost(g as any, kleinunternehmer), 0)
    if (total > GIFT_LIMIT + 1e-9) for (const g of list) out.add(g.id)
  }
  return out
}

/**
 * The non-deductible gifts among `expenses` (anything with id and category),
 * judged against all the company's gifts of their years.
 */
export async function nonDeductibleGiftIds(
  prisma: any,
  companyId: string,
  expenses: Array<{ id?: string; category?: string | null }>,
  kleinunternehmer: boolean,
): Promise<Set<string>> {
  const ids = expenses.filter((e) => e.id && isGeschenk(e)).map((e) => e.id as string)
  if (ids.length === 0) return new Set()
  const dated: Array<{ invoiceDate: Date }> = await prisma.expense.findMany({
    where: { companyId, id: { in: ids } },
    select: { invoiceDate: true },
  })
  const years = [...new Set(dated.map((d) => new Date(d.invoiceDate).getFullYear()))]
  const gifts: GiftRow[] = await prisma.expense.findMany({
    where: {
      companyId,
      status: { in: ['booked', 'deductible'] },
      category: { startsWith: 'Geschenk', mode: 'insensitive' },
      OR: years.map((y) => ({ invoiceDate: { gte: new Date(y, 0, 1), lte: new Date(y, 11, 31, 23, 59, 59, 999) } })),
    },
    select: { id: true, invoiceDate: true, netAmount: true, grossAmount: true, giftRecipient: true },
  })
  const bad = nonDeductibleGifts(gifts, kleinunternehmer)
  return new Set(ids.filter((id) => bad.has(id)))
}

/** The gross amount of the non-deductible gifts (cost and input tax). */
export function nichtAbziehbareGeschenke(
  expenses: Array<{ id?: string; grossAmount?: unknown }>,
  bad: Set<string>,
): number {
  const sum = expenses.reduce((s, e) => s + (e.id && bad.has(e.id) ? Number(e.grossAmount ?? 0) : 0), 0)
  return Math.round(sum * 100) / 100
}
