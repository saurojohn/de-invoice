/**
 * Tier 419 — what an expense costs the business.
 *
 * GuV and BWA summed `grossAmount`: the supplier's price *including* VAT.
 * For a business entitled to deduct input tax, that VAT is not a cost — it
 * comes back through the UStVA (Vorsteuer) — so both reports overstated every
 * expense by its VAT. Measured: 1 000 € revenue and three 119 € expenses
 * (100 € net each) gave a GuV Jahresüberschuss and BWA result of 643 €;
 * EÜR, Anlage S and Anlage G — which already used `netAmount` — said 700 €.
 *
 * A Kleinunternehmer (§ 19 UStG, `Company.defaultVatMode`) cannot deduct input
 * tax: for them the gross amount is the cost.
 */
type Num = { toString(): string } | number | null | undefined

export interface CostExpense {
  netAmount?: Num
  grossAmount?: Num
}

export function expenseCost(e: CostExpense, kleinunternehmer: boolean): number {
  const v = kleinunternehmer ? e.grossAmount : e.netAmount ?? e.grossAmount
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Tier 485 — entertainment (Bewirtung, category starting "Bewirtung"): only
 * 70 % of the cost is a Betriebsausgabe for the tax profit (§ 4 Abs. 5 Nr. 2
 * EStG; the input tax stays fully deductible). The commercial GuV / BWA keep
 * 100 % — the 30 % is added back outside the books (EÜR, Anlage S / G, KSt 1).
 */
export const BEWIRTUNG_ABZIEHBAR = 0.7

export function isBewirtung(e: { category?: string | null }): boolean {
  return /^Bewirtung/i.test(e.category || '')
}

/**
 * Tier 539 — a Bewirtung is deductible only with its record: place, day,
 * participants, occasion and amount (§ 4 Abs. 5 Nr. 2 Satz 2 EStG). Place,
 * day and amount are on the bill; the occasion and the participants are what
 * the taxpayer adds — without them the Betriebsprüfung strikes the whole
 * amount. The app does not strike it itself (the paper Beleg may carry the
 * record); it says which ones have none entered.
 */
export function bewirtungNachweisFehlt(e: {
  category?: string | null
  grossAmount?: unknown
  bewirtungAnlass?: string | null
  bewirtungTeilnehmer?: string | null
}): boolean {
  if (!isBewirtung(e) || Number(e.grossAmount ?? 0) < 0) return false
  return !(e.bewirtungAnlass || '').trim() || !(e.bewirtungTeilnehmer || '').trim()
}

/** The cost that counts for the tax profit: 70 % of an entertainment expense. */
export function deductibleCost(e: CostExpense & { category?: string | null }, kleinunternehmer: boolean): number {
  const cost = expenseCost(e, kleinunternehmer)
  return isBewirtung(e) ? Math.round(cost * BEWIRTUNG_ABZIEHBAR * 100) / 100 : cost
}

/** The non-deductible 30 % of the entertainment expenses. */
export function nichtAbziehbareBewirtung(
  expenses: Array<CostExpense & { category?: string | null }>,
  kleinunternehmer: boolean,
): number {
  const sum = expenses.reduce((s, e) => s + (isBewirtung(e) ? expenseCost(e, kleinunternehmer) - deductibleCost(e, kleinunternehmer) : 0), 0)
  return Math.round(sum * 100) / 100
}
