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
 * in the period the invoice is issued — at the latest the month after the
 * delivery (§ 18b Satz 2 UStG, as the ZM; Tier 914, `iglDeadline`), and a
 * credit note in the period of the change it records (§ 17 Abs. 1 Satz 7
 * UStG) — both by their issue date.
 */
import { businessDayIso } from '../../common/business-date'

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

/**
 * Tier 914 — an innergemeinschaftliche Lieferung is declared with its
 * invoice, but at the latest for the month after the delivery (§ 13 Abs. 1
 * Nr. 6, § 18b Satz 2, § 18a Abs. 8 UStG). Measured: delivered 10.09.,
 * invoiced 22.11. — in the UStVA (Kz 41) and the ZM of November; the law
 * puts it in October. The last day of the month after the delivery.
 */
export function iglDeadline(inv: Dated): Date {
  const [y, m] = businessDayIso(supplyDay(inv)).split('-').map(Number)
  return new Date(Date.UTC(y, m + 1, 0))
}

/**
 * Tier 919 — the day revenue is realised in the books (GuV, Bilanz, Anlage G
 * by Bilanz): the supply (§ 252 Abs. 1 Nr. 4 HGB), not an earlier invoice. An
 * invoice written before the supply is a pending contract until then — paid,
 * an erhaltene Anzahlung (Bilanz). A credit note by its own date. The UStVA
 * keeps `revenueDay` (an early invoice is declared early, Tier 913).
 */
export function bookingDay(inv: Dated & { type?: string | null }): Date {
  return inv.type === 'CN' ? inv.issueDate : supplyDay(inv)
}

/**
 * Tier 921 — Mindest-Ist instead of the invoice date. Tier 913 declared an
 * invoice written before its supply (a Vorausrechnung) in its own period, in
 * full, paid or not. § 13 Abs. 1 Nr. 1 a UStG: the tax arises with the supply;
 * only a payment received before it is owed earlier, when received, and only
 * for its amount (Satz 4). Measured: invoiced 22.11. for a delivery on 03.12.,
 * unpaid — declared in November (and, at the year's end, in the wrong UStJA).
 * Now an invoice is in the period of its supply; the UStVA declares the
 * payments received before the supply in their periods and takes them off the
 * supply's (UstvaService, `paidBeforeSupply`).
 */
export function isVorausrechnung(inv: Dated): boolean {
  return !inv.euTransaction && supplyDay(inv).getTime() > inv.issueDate.getTime()
}

/** Tier 921: a payment on this day is taxed when received (Mindest-Ist) — it comes before the supply */
export function taxedOnReceipt(inv: Dated, paymentDate: Date | string): boolean {
  const day = typeof paymentDate === 'string' ? paymentDate.slice(0, 10) : businessDayIso(paymentDate)
  return !inv.euTransaction && day < businessDayIso(supplyDay(inv))
}

/** the day that puts an invoice into a UStVA period */
export function ustvaDay(inv: Dated): Date {
  if (!inv.euTransaction) return supplyDay(inv) // Tier 921 (Tier 913 had the earlier of supply and invoice)
  const deadline = iglDeadline(inv)
  return deadline.getTime() < inv.issueDate.getTime() ? deadline : inv.issueDate
}

/** a where clause for the invoices that may belong to [start, end] — filter with `within` after */
export function supplyPeriodWhere(start: Date, end: Date) {
  const range = { gte: start, lte: end }
  // Tier 914: an igL delivered in the month before, invoiced later, is the period's too
  const iglRange = { gte: new Date(start.getFullYear(), start.getMonth() - 1, 1), lte: end }
  return {
    OR: [
      { issueDate: range }, { deliveryDate: range }, { servicePeriodEnd: range },
      { euTransaction: true, deliveryDate: iglRange }, { euTransaction: true, servicePeriodEnd: iglRange },
    ],
  }
}

export const within = (d: Date, start: Date, end: Date) => d.getTime() >= start.getTime() && d.getTime() <= end.getTime()
