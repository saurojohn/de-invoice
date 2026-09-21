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
