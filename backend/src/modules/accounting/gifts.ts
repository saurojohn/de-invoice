/**
 * Tier 503 — business gifts (Geschenke an Geschäftsfreunde).
 *
 * § 4 Abs. 5 Nr. 1 EStG: gifts to people who are not employees are a
 * Betriebsausgabe only if all gifts to that recipient in the year cost no
 * more than 50 € — 35 € in the years up to 2023 (Tier 682; the limit was
 * raised for business years from 2024 on) — net; gross for a business
 * without input-tax deduction.
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
import { Ku } from '../../common/kleinunternehmer-period'

export const GIFT_LIMIT = 50
/** § 4 Abs. 5 Satz 1 Nr. 1 EStG: 50 € from 2024, 35 € before. */
export const giftLimitFor = (year: number): number => (year >= 2024 ? GIFT_LIMIT : 35)
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
export function nonDeductibleGifts(gifts: GiftRow[], kleinunternehmer: Ku): Set<string> {
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
  for (const [key, list] of byRecipient) {
    const total = list.reduce((s, g) => s + expenseCost(g as any, kleinunternehmer), 0)
    if (total > giftLimitFor(Number(key.split('|')[0])) + 1e-9) for (const g of list) out.add(g.id)
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
  kleinunternehmer: Ku,
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

/**
 * Tier 940 — the input tax of gifts in a UStVA period (§ 15 Abs. 1a UStG).
 *
 * The 50 € limit is judged per recipient over the year (above). The UStVA
 * applied that judgement to every period of the year: a December gift that
 * took a recipient over the limit removed the input tax of his gift of
 * October — from October's return, already submitted. Measured: Kz 66
 * October 7,60 € → 0 after a second gift in November. The deduction is
 * corrected in the period in which the limit is passed (§ 17 Abs. 2 Nr. 5
 * UStG, UStAE 15.6 Abs. 5); the periods before keep theirs.
 *
 * Returns the gifts of [start, end] that give no input tax (the recipient's
 * gifts up to `end` are above the limit; a gift without a recipient above
 * the Streuartikel limit), and the input tax of the recipient's earlier gifts
 * of the year, by rate, to take back in this period — where the limit is
 * passed in it.
 */
export async function giftInputTaxOfPeriod(
  prisma: any,
  companyId: string,
  start: Date,
  end: Date,
): Promise<{ notDeductible: Set<string>; takeBack: Map<number, number> }> {
  const year = end.getFullYear()
  const gifts: Array<GiftRow & { vatRate: unknown; vatAmount: unknown }> = await prisma.expense.findMany({
    where: {
      companyId,
      status: { in: ['booked', 'deductible'] },
      category: { startsWith: 'Geschenk', mode: 'insensitive' },
      invoiceDate: { gte: new Date(year, 0, 1), lte: end },
    },
    select: { id: true, invoiceDate: true, netAmount: true, grossAmount: true, giftRecipient: true, vatRate: true, vatAmount: true },
    orderBy: { invoiceDate: 'asc' },
  })
  const notDeductible = new Set<string>()
  const takeBack = new Map<number, number>()
  const inPeriod = (g: { invoiceDate: Date }) => new Date(g.invoiceDate).getTime() >= start.getTime()
  const byRecipient = new Map<string, typeof gifts>()
  for (const g of gifts) {
    const who = norm(g.giftRecipient)
    if (!who) {
      if (inPeriod(g) && expenseCost(g as any, false) > STREUARTIKEL_LIMIT) notDeductible.add(g.id)
      continue
    }
    byRecipient.set(who, [...(byRecipient.get(who) ?? []), g])
  }
  const limit = giftLimitFor(year) + 1e-9
  for (const list of byRecipient.values()) {
    const upToEnd = list.reduce((s, g) => s + expenseCost(g as any, false), 0)
    if (upToEnd <= limit) continue
    const earlier = list.filter((g) => !inPeriod(g))
    const before = earlier.reduce((s, g) => s + expenseCost(g as any, false), 0)
    for (const g of list) if (inPeriod(g)) notDeductible.add(g.id)
    if (before <= limit) {
      // passed in this period: the input tax claimed before comes back now
      for (const g of earlier) {
        const r = Number(g.vatRate)
        takeBack.set(r, (takeBack.get(r) ?? 0) + Number(g.vatAmount ?? 0))
      }
    }
  }
  return { notDeductible, takeBack }
}
