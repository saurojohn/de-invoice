/**
 * Tier 641 — which sales carry another member state's tax.
 *
 * A sale to a consumer in another EU member state at that state's rate
 * (France 20 %, Austria 20 % / 10 %, …) is taxed there: the tax goes to that
 * state through the OSS return at the BZSt (§ 18j UStG), not to the Finanzamt.
 * The UStVA sorted every rate that is not 19 % or 7 % into Kz 35 / 36 —
 * "steuerpflichtige Umsätze zu anderen Steuersätzen", German tax — so French
 * tax was declared as German tax owed, next to the OSS report that declared
 * it as French.
 *
 * What can be told from the invoice alone: the customer has no VAT id and
 * lives in another member state, and the rate is none German law has had.
 *
 * Tier 649: and what the company says of itself — `Company.ossVerfahren`.
 * A seller in the OSS taxes every sale to a consumer in another member state
 * there, also where that state's rate is 19 % like the German one (Cyprus).
 * A seller who is not (below the 10 000 € threshold of § 3c Abs. 4 UStG)
 * charges German tax on such a sale at 19 % / 7 %, and it is German tax.
 */
import { normaliseCountry } from '../invoice/ust-behandlung-detector'

export const EU_COUNTRY_CODES = new Set<string>([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
])

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10)

/** 19 % and 7 %; 16 % and 5 % from 1 July to 31 December 2020. */
export function isGermanRate(rate: number, date: Date | string): boolean {
  const r = Math.round(rate * 10000) / 10000
  if (r === 0.19 || r === 0.07) return true
  return (r === 0.16 || r === 0.05) && day(date) >= '2020-07-01' && day(date) <= '2020-12-31'
}

type Customer = { vatId?: string | null; address?: unknown } | null | undefined

/** The member state of a customer without a VAT id who lives in another one than the seller — or null. */
export function consumerAbroad(customer: Customer, homeCountry = 'DE'): string | null {
  if (!customer || (customer.vatId && customer.vatId.trim())) return null
  const country = normaliseCountry((customer.address as { country?: string } | null)?.country)
  if (!country || !EU_COUNTRY_CODES.has(country) || country === homeCountry) return null
  return country
}

/** A taxed amount of a document that is another member state's tax, not German. */
export function taxedAbroad(
  doc: { issueDate: Date | string; customer?: Customer },
  rate: number,
  homeCountry = 'DE',
  ossVerfahren = false,
): boolean {
  return rate > 0 && (ossVerfahren || !isGermanRate(rate, doc.issueDate)) && consumerAbroad(doc.customer, homeCountry) !== null
}
