import { businessDayIso, businessToday, dayEnd, dayStart } from '../../common/business-date'
import { isKapitalgesellschaft, resolveRechtsform } from '../company/rechtsform'

/**
 * Tier 502 — private use of a company car.
 *
 * A sole trader or partnership whose car is a business asset and also used
 * privately withdraws, per calendar month, 1 % of its gross list price
 * (§ 6 Abs. 1 Nr. 4 Satz 2 EStG; the list price rounded down to full
 * hundreds; a month counts in full when the car was there on any day of it).
 * Electric cars: 0,25 % (list price up to the statutory limit) or 0,5 % —
 * the reduction is an income-tax rule only.
 *
 * VAT (§ 3 Abs. 9a Nr. 1 UStG, unentgeltliche Wertabgabe): the 1 % value of
 * the full list price, less 20 % for costs that carried no input tax, at
 * 19 % (Abschn. 15.23 Abs. 5 UStAE) — also for an electric car.
 *
 * None of this was modelled: the EÜR / Anlage S / Anlage G had no private
 * use, the UStVA no Wertabgabe, DATEV no booking.
 *
 * Tier 541 — trips between home and the (first) business premises
 * (§ 4 Abs. 5 Satz 1 Nr. 6 EStG): per month 0,03 % of the list price (for an
 * electric car a quarter / half of it) per kilometre of the one-way distance
 * is not a business expense — less the Entfernungspauschale the owner may
 * deduct like an employee (0,30 € per km for the first 20 km, 0,38 € from
 * the 21st, per day with the trip). The positive difference is added to the
 * profit with the private use; it carries no VAT.
 *
 * Not covered: the Fahrtenbuch method, the Kostendeckelung, the 0,002 % per
 * trip for fewer than 15 days a month. A Kapitalgesellschaft's car used privately
 * by its managing director is payroll (geldwerter Vorteil), not this.
 */
export const COMPANY_CAR_METHODS = ['one_percent', 'electric_025', 'electric_05'] as const
export type CompanyCarMethod = (typeof COMPANY_CAR_METHODS)[number]

const INCOME_RATE: Record<CompanyCarMethod, number> = {
  one_percent: 0.01,
  electric_025: 0.0025,
  electric_05: 0.005,
}
const VAT_SHARE = 0.8 // less 20 % for costs without input tax
const VAT_RATE = 0.19
/** Tier 541: days per month with a trip home – business, when none is given */
export const DEFAULT_COMMUTE_DAYS = 15
const COMMUTE_RATE = 0.0003
const PAUSCHALE_FIRST_20 = 0.3
const PAUSCHALE_FROM_21 = 0.38

export interface CarLike {
  id: string
  name: string
  listPrice: unknown
  method: string
  fromDate: Date
  untilDate: Date | null
  commuteKm?: number | null
  commuteDays?: number | null
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** The list price rounded down to full hundreds. */
export function roundedListPrice(listPrice: unknown): number {
  return Math.floor(Number(listPrice) / 100) * 100
}

/** Whether the car is there on any day of the month (month 1-12). */
function inMonth(car: CarLike, year: number, month: number): boolean {
  const first = Date.UTC(year, month - 1, 1)
  const last = Date.UTC(year, month, 0)
  const from = new Date(car.fromDate).getTime()
  const until = car.untilDate ? new Date(car.untilDate).getTime() : Infinity
  return from <= last && until >= first
}

/** The month's values for one car (income-tax value, VAT base, VAT). */
export function monthlyPrivateUse(car: CarLike, kleinunternehmer: boolean) {
  const price = roundedListPrice(car.listPrice)
  const rate = INCOME_RATE[car.method as CompanyCarMethod] ?? INCOME_RATE.one_percent
  const income = r2(price * rate)
  const vatBase = kleinunternehmer ? 0 : r2(price * 0.01 * VAT_SHARE)
  const vat = r2(vatBase * VAT_RATE)
  return { income, vatBase, vat }
}

/**
 * Tier 541 — the month's non-deductible cost of the trips home – business:
 * 0,03 % × list price × km, less the Entfernungspauschale; never below 0.
 */
export function monthlyCommute(car: CarLike) {
  const km = Number(car.commuteKm ?? 0)
  if (!(km > 0)) return { pauschal: 0, entfernungspauschale: 0, commute: 0 }
  const days = car.commuteDays ?? DEFAULT_COMMUTE_DAYS
  // The electric reduction applies to the list price here too.
  const factor = (INCOME_RATE[car.method as CompanyCarMethod] ?? INCOME_RATE.one_percent) / INCOME_RATE.one_percent
  const pauschal = r2(roundedListPrice(car.listPrice) * factor * COMMUTE_RATE * km)
  const entfernungspauschale = r2(days * (Math.min(km, 20) * PAUSCHALE_FIRST_20 + Math.max(km - 20, 0) * PAUSCHALE_FROM_21))
  return { pauschal, entfernungspauschale, commute: r2(Math.max(0, pauschal - entfernungspauschale)) }
}

export interface PrivateUseMonth {
  year: number
  month: number
  carId: string
  carName: string
  income: number
  vatBase: number
  vat: number
  /** Tier 541: non-deductible trips home – business (in `income` too) */
  commute: number
}

/**
 * The private use in [from, to] (whole months), per car and month, and the
 * totals. Nothing for a Kapitalgesellschaft.
 */
export async function privateCarUse(prisma: any, companyId: string, from: Date, to: Date) {
  const empty = { income: 0, vatBase: 0, vat: 0, commute: 0, months: [] as PrivateUseMonth[] }
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true, legalName: true, rechtsform: true, settings: true, defaultVatMode: true },
  })
  if (!company || isKapitalgesellschaft(resolveRechtsform(company).rechtsform)) return empty
  const cars: CarLike[] = await prisma.companyCar.findMany({ where: { companyId } })
  if (cars.length === 0) return empty
  const kleinunternehmer = company.defaultVatMode === 'kleinunternehmer'

  const months: PrivateUseMonth[] = []
  // The period's calendar months in Germany (callers pass local or UTC midnights).
  const [fy, fm] = businessDayIso(from).split('-').map(Number)
  const [ty, tm] = businessDayIso(to).split('-').map(Number)
  let y = fy
  let m = fm
  // Not beyond the current month: a report of the running year shows what
  // has happened, not the rest of the year in advance.
  const now = businessToday()
  const endKey = Math.min(ty * 12 + (tm - 1), now.y * 12 + now.m) // businessToday: 0-based month
  const HALF_DAY = 12 * 3600 * 1000
  while (y * 12 + (m - 1) <= endKey) {
    // Callers end a period at local or at UTC midnight; a boundary month
    // reached by less than half a day is not part of the period.
    const mStart = dayStart(y, m - 1, 1).getTime() // dayStart / dayEnd: 0-based month
    const mEnd = dayEnd(y, m - 1, new Date(Date.UTC(y, m, 0)).getUTCDate()).getTime()
    const overlap = Math.min(mEnd, to.getTime()) - Math.max(mStart, from.getTime())
    if (overlap < HALF_DAY) {
      m++
      if (m > 12) { m = 1; y++ }
      continue
    }
    for (const car of cars) {
      if (!inMonth(car, y, m)) continue
      const use = monthlyPrivateUse(car, kleinunternehmer)
      const { commute } = monthlyCommute(car)
      // The trips home – business are added to the profit with the private use.
      months.push({ year: y, month: m, carId: car.id, carName: car.name, ...use, income: r2(use.income + commute), commute })
    }
    m++
    if (m > 12) { m = 1; y++ }
  }
  return {
    income: r2(months.reduce((s, x) => s + x.income, 0)),
    vatBase: r2(months.reduce((s, x) => s + x.vatBase, 0)),
    vat: r2(months.reduce((s, x) => s + x.vat, 0)),
    commute: r2(months.reduce((s, x) => s + x.commute, 0)),
    months,
  }
}
