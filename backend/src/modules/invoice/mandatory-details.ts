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

type Address = { street?: string | null; postalCode?: string | null; city?: string | null } | null | undefined

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== ''
const addressComplete = (a: Address) => !!a && filled(a.street) && filled(a.postalCode) && filled(a.city)

export function missingInvoiceDetails(
  invoice: { total?: unknown; eurTotal?: unknown; euTransaction?: boolean | null; reverseCharge?: boolean | null },
  company: { name?: string | null; legalName?: string | null; address?: unknown; taxId?: string | null; vatId?: string | null },
  customer: { name?: string | null; address?: unknown } | null | undefined,
): string[] {
  const missing: string[] = []
  const gross = Math.abs(Number(invoice.eurTotal ?? invoice.total ?? 0))
  const kleinbetrag = gross <= KLEINBETRAG_LIMIT_EUR && !invoice.euTransaction && !invoice.reverseCharge

  if (!filled(company.legalName) && !filled(company.name)) missing.push('Name Ihres Unternehmens')
  if (!addressComplete(company.address as Address)) missing.push('Anschrift Ihres Unternehmens (Straße, PLZ, Ort)')
  if (kleinbetrag) return missing

  if (!filled(company.taxId) && !filled(company.vatId)) missing.push('Steuernummer oder USt-IdNr. Ihres Unternehmens')
  if (!customer || !filled(customer.name)) missing.push('Name des Kunden')
  if (!addressComplete(customer?.address as Address)) missing.push('Anschrift des Kunden (Straße, PLZ, Ort)')
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
