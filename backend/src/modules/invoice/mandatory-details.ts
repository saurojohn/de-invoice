import { zeroRatedGround } from './zero-rated'
import { BadRequestException } from '@nestjs/common'

/**
 * Tier 494 — the mandatory details of an invoice (§ 14 Abs. 4 UStG), checked
 * when it is issued.
 *
 * A freshly registered company (empty address, no Steuernummer / USt-IdNr.)
 * issued a 1 190 € invoice to a customer without an address — measured. Such
 * an invoice is no proper invoice: the recipient loses the input-tax
 * deduction, and the PDF / XRechnung carried empty fields.
 *
 * Kleinbetragsrechnung (§ 33 UStDV): up to 250 € gross the supplier's name
 * and address suffice — no tax number, no customer. Not for an igL or § 13b
 * invoice (§ 33 Satz 3 UStDV).
 */
export const KLEINBETRAG_LIMIT_EUR = 250

type Address = { street?: string | null; postalCode?: string | null; city?: string | null; country?: string | null } | null | undefined

/** Member states (ISO country codes, as stored in addresses). */
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DE', 'DK', 'EE', 'FI', 'FR', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== ''
const addressComplete = (a: Address) => !!a && filled(a.street) && filled(a.postalCode) && filled(a.city)

/**
 * Tier 690 — what counts as naming the exemption in the remarks: a paragraph
 * ("§ 4 Nr. 21 UStG"), an article ("Art. 132 MwStSystRL") or the word itself.
 */
export const EXEMPTION_HINT = /§\s*\d|steuerfrei|steuerbefrei|umsatzsteuerfrei|befreit|art(?:\.|ikel)\s*\d/i

export const EXEMPTION_MISSING =
  'Hinweis auf die Steuerbefreiung — in den Bemerkungen, z. B. „Steuerfrei nach § 4 Nr. 21 UStG“ (§ 14 Abs. 4 Nr. 8 UStG)'

export function missingInvoiceDetails(
  invoice: {
    total?: unknown; eurTotal?: unknown; euTransaction?: boolean | null; reverseCharge?: boolean | null
    /** Tier 690: the rates of the lines, and the remarks that would name an exemption */
    items?: { vatRate?: unknown }[]; notes?: string | null
  },
  company: { name?: string | null; legalName?: string | null; address?: unknown; taxId?: string | null; vatId?: string | null; defaultVatMode?: string | null },
  customer: { name?: string | null; address?: unknown; vatId?: string | null } | null | undefined,
): string[] {
  const missing: string[] = []
  const gross = Math.abs(Number(invoice.eurTotal ?? invoice.total ?? 0))
  const kleinbetrag = gross <= KLEINBETRAG_LIMIT_EUR && !invoice.euTransaction && !invoice.reverseCharge

  if (!filled(company.legalName) && !filled(company.name)) missing.push('Name Ihres Unternehmens')
  // Tier 690 — a line without VAT that is neither an igL, a § 13b / EU
  // service, a service abroad nor an export (zero-rated.ts: "exempt") is a
  // tax-exempt sale in Germany: the invoice names the exemption (§ 14 Abs. 4
  // Nr. 8 UStG; a Kleinbetragsrechnung too, § 33 Satz 1 Nr. 4 UStDV). The
  // program cannot know which § 4 applies, so the remarks have to say it.
  // A Kleinunternehmer's invoices carry the § 19 note instead.
  const zeroRatedLine = (invoice.items ?? []).some((it) => Math.abs(Number(it.vatRate ?? 0)) < 0.00005)
  if (
    zeroRatedLine &&
    company.defaultVatMode !== 'kleinunternehmer' &&
    zeroRatedGround(invoice, (customer?.address as Address)?.country, customer?.vatId) === 'exempt' &&
    !EXEMPTION_HINT.test(invoice.notes ?? '')
  ) {
    missing.push(EXEMPTION_MISSING)
  }
  if (!addressComplete(company.address as Address)) missing.push('Anschrift Ihres Unternehmens (Straße, PLZ, Ort)')
  if (kleinbetrag) return missing

  if (!filled(company.taxId) && !filled(company.vatId)) missing.push('Steuernummer oder USt-IdNr. Ihres Unternehmens')
  if (!customer || !filled(customer.name)) missing.push('Name des Kunden')
  if (!addressComplete(customer?.address as Address)) missing.push('Anschrift des Kunden (Straße, PLZ, Ort)')

  // Tier 498 — § 14a Abs. 1 / 3 UStG: an igL, or a service whose tax the
  // customer in another member state owes, states both USt-IdNrn.; a
  // Steuernummer does not do.
  const country = String((customer?.address as Address)?.country || '').trim().toUpperCase()
  const euReverseCharge = !!invoice.reverseCharge && country !== '' && country !== 'DE' && EU_COUNTRIES.includes(country)
  if (invoice.euTransaction || euReverseCharge) {
    if (!filled(company.vatId)) missing.push('USt-IdNr. Ihres Unternehmens (§ 14a UStG — eine Steuernummer genügt hier nicht)')
    if (!filled(customer?.vatId)) missing.push('USt-IdNr. des Kunden (§ 14a UStG)')
  }
  return missing
}

export function assertInvoiceDetails(...args: Parameters<typeof missingInvoiceDetails>): void {
  const missing = missingInvoiceDetails(...args)
  if (missing.length) {
    throw new BadRequestException(
      `Die Rechnung kann nicht ausgestellt werden — es fehlen Pflichtangaben (§ 14 Abs. 4 UStG): ${missing.join(', ')}.`,
    )
  }
}
