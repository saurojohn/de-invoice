/**
 * Tier 912 — an invoice is in the return of the period of its supply.
 *
 * § 13 Abs. 1 Nr. 1 a UStG: under Soll-Versteuerung the tax arises with the
 * end of the Voranmeldungszeitraum in which the supply was made — not the one
 * in which the invoice was written. The returns read the issue date only
 * (Tier 492 noted it: "nothing reads deliveryDate there"). Measured: a
 * December supply invoiced on 2 January (Leistungsdatum 15.12.) was declared
 * in January — and in the next year's UStJA; a service period ending in
 * October, invoiced in November, in November.
 *
 * The day of the supply: the end of the Leistungszeitraum, else the
 * Leistungsdatum, else the issue date (which the invoice then states as the
 * Leistungsdatum, Tier 492). An innergemeinschaftliche Lieferung is declared
 * in the period the invoice is issued (§ 18b Satz 2 UStG, as the ZM), and a
 * credit note in the period of the change it records (§ 17 Abs. 1 Satz 7
 * UStG) — both by their issue date.
 */
type Dated = {
  issueDate: Date
  deliveryDate?: Date | null
  servicePeriodEnd?: Date | null
  euTransaction?: boolean | null
}

export const SUPPLY_SELECT = { issueDate: true, deliveryDate: true, servicePeriodEnd: true, euTransaction: true } as const

export function supplyDay(inv: Dated): Date {
  return inv.servicePeriodEnd ?? inv.deliveryDate ?? inv.issueDate
}

/**
 * Tier 913 — the earlier of the supply and the invoice. A supply made before
 * its invoice is in the period of the supply (above). An invoice written
 * before the supply (a Vorausrechnung — a shop's prepayment, shipped the
 * next day) stays in its own period: a payment received on it is owed when
 * received (§ 13 Abs. 1 Nr. 1 a Satz 4 UStG), and a tax declared early is
 * not one declared late. Tier 912 had moved it to the later month.
 */
export function revenueDay(inv: Dated): Date {
  const s = supplyDay(inv)
  return s.getTime() < inv.issueDate.getTime() ? s : inv.issueDate
}

/** the day that puts an invoice into a UStVA period */
export function ustvaDay(inv: Dated): Date {
  return inv.euTransaction ? inv.issueDate : revenueDay(inv)
}

/** a where clause for the invoices that may belong to [start, end] — filter with `within` after */
export function supplyPeriodWhere(start: Date, end: Date) {
  const range = { gte: start, lte: end }
  return { OR: [{ issueDate: range }, { deliveryDate: range }, { servicePeriodEnd: range }] }
}

export const within = (d: Date, start: Date, end: Date) => d.getTime() >= start.getTime() && d.getTime() <= end.getTime()
