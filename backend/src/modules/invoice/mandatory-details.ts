import { KuCompany, kuOn } from '../../common/kleinunternehmer-period'
import { businessTodayIso } from '../../common/business-date'
import { zeroRatedGround } from './zero-rated'
import { BadRequestException } from '@nestjs/common'
import { consumerAbroad, isGermanRate } from '../reports/oss-scope'

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
    /** Tier 899: and what each line is — checked where it is given */
    items?: { vatRate?: unknown; description?: string | null }[]; notes?: string | null
    /** Tier 842: whether § 19 applied on it (kleinunternehmer-period.ts); today if not given */
    issueDate?: Date | string | null
    /** Tier 899: the date of supply — a rate is the one in force then */
    deliveryDate?: Date | string | null; servicePeriodStart?: Date | string | null; servicePeriodEnd?: Date | string | null
  },
  company: { name?: string | null; legalName?: string | null; address?: unknown; taxId?: string | null; vatId?: string | null } & KuCompany,
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
    !kuOn(company)(invoice.issueDate ?? businessTodayIso()) &&
    zeroRatedGround(invoice, (customer?.address as Address)?.country, customer?.vatId) === 'exempt' &&
    !EXEMPTION_HINT.test(invoice.notes ?? '')
  ) {
    missing.push(EXEMPTION_MISSING)
  }
  if (!addressComplete(company.address as Address)) missing.push('Anschrift Ihres Unternehmens (Straße, PLZ, Ort)')
  // Tier 899 — what was supplied, in every line (§ 14 Abs. 4 Nr. 5 UStG; a
  // Kleinbetragsrechnung too, § 33 Satz 1 Nr. 3 UStDV; BT-153 of the
  // e-invoice). Measured: a line with an empty description was issued.
  if ((invoice.items ?? []).some((it) => 'description' in it && !filled(it.description))) {
    missing.push('Bezeichnung der Leistung in jeder Position (Art und Umfang, § 14 Abs. 4 Nr. 5 UStG)')
  }
  // Tier 899 — the rate is one German law has (§ 12 UStG: 19 % / 7 %; 16 % /
  // 5 % for a supply from July to December 2020). Measured: a line at 50 %
  // to a customer in Berlin was issued, and the UStVA declared it in Kz 35 /
  // 36. Another rate is only that of another member state, for a sale to a
  // consumer there (OSS, oss-scope.ts).
  const dates = [invoice.issueDate ?? businessTodayIso(), invoice.deliveryDate, invoice.servicePeriodStart, invoice.servicePeriodEnd]
    .filter((d): d is Date | string => !!d && !Number.isNaN(new Date(d).getTime()))
  const foreignRates = [...new Set((invoice.items ?? [])
    .map((it) => Math.round(Number(it.vatRate ?? 0) * 10000) / 10000)
    .filter((r) => r > 0 && !dates.some((d) => isGermanRate(r, d))))]
  if (foreignRates.length && !consumerAbroad(customer)) {
    const pct = foreignRates.map((r) => `${String(Math.round(r * 10000) / 100).replace('.', ',')} %`).join(', ')
    missing.push(
      `ein Steuersatz, den das deutsche Umsatzsteuerrecht kennt — ${pct} gibt es nicht (19 % oder 7 %, § 12 UStG; ` +
      'ein anderer Satz nur beim Verkauf an einen Verbraucher in einem anderen EU-Staat)',
    )
  }
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
