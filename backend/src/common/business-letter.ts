/**
 * Tier 728 / 728b — what every business letter of a company carries, and how
 * a country is written on an address.
 *
 * § 35a GmbHG, § 37a / § 125a / § 177a HGB, § 80 AktG: on every business
 * letter (an invoice, a reminder, a statement, an e-mail) the company's full
 * name with its legal form, its seat, the register court and number, and all
 * managing directors. § 14 Abs. 4 UStG adds the tax number on an invoice.
 * The invoice PDF lays these out in its own footer; the reminder and the
 * statement use these lines.
 */

export interface LetterCompany {
  name?: string | null
  legalName?: string | null
  address?: { street?: string | null; postalCode?: string | null; city?: string | null; country?: string | null } | null
  phone?: string | null
  fax?: string | null
  email?: string | null
  website?: string | null
  taxId?: string | null
  vatId?: string | null
  bankInfo?: { bankName?: string | null; iban?: string | null; bic?: string | null } | null
  registerEntry?: string | null
  managingDirector?: string | null
  otherInfo?: string | null
}

/** "IBAN DE89…" with a no-break space — a line breaks between the parts, not inside one */
const lv = (label: string, value: unknown) => (value ? `${label}\u00A0${String(value).trim()}` : '')

/**
 * The footer lines of a business letter: who (name, address, contact), the
 * register details (seat, register, directors), what else the company states,
 * tax numbers and bank. Empty parts and lines are left out.
 */
export function businessLetterFooter(c: LetterCompany): string[] {
  const a = c.address || {}
  const name = String(c.legalName || c.name || '').trim()
  const bank = c.bankInfo || {}
  return [
    [name, a.street, [a.postalCode, a.city].filter(Boolean).join(' '), lv('Tel.', c.phone), lv('Fax', c.fax), c.email, c.website],
    registerDetails(c),
    String(c.otherInfo || '').split(/\r?\n/),
    [lv('Steuer-Nr.', c.taxId), lv('USt-IdNr.', c.vatId), lv('Bank', bank.bankName), lv('IBAN', bank.iban), lv('BIC', bank.bic)],
  ]
    .map((parts) => parts.map((p) => String(p || '').trim()).filter(Boolean).join(' · '))
    .filter(Boolean)
}

/** Seat (for a registered company, unless the other details name it), register, directors */
function registerDetails(c: LetterCompany): string[] {
  const city = c.address?.city
  const seat = c.registerEntry && city && !/\bsitz\b/i.test(String(c.otherInfo || '')) ? lv('Sitz der Gesellschaft:', city) : ''
  return [seat, lv('Handelsregister:', c.registerEntry), lv('Geschäftsführer:', c.managingDirector)]
}

/**
 * Tier 728g — the same details in the e-invoice: BT-33 „Seller additional
 * legal information“ (UBL `CompanyLegalForm`, CII `Description`). Since 2025
 * the e-invoice is the invoice a business receives; its XML prevails over
 * the PDF it may be embedded in. Plain spaces (a no-break space is for a
 * page's line breaks). Empty when there is nothing to state.
 */
export function sellerLegalInformation(c: LetterCompany): string {
  return [...registerDetails(c), ...String(c.otherInfo || '').split(/\r?\n/)]
    .map((p) => String(p || '').replace(/\u00A0/g, ' ').trim())
    .filter(Boolean)
    .join(' · ')
}

/** An address's country as an ISO code ("DE"), whatever was stored ("DE", "Deutschland") */
export function countryCode(value: unknown): string {
  const v = String(value ?? '').trim()
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase()
  const names: Record<string, string> = { deutschland: 'DE', germany: 'DE', österreich: 'AT', austria: 'AT', schweiz: 'CH', switzerland: 'CH' }
  return names[v.toLowerCase()] ?? v.toUpperCase()
}

/** The country line of an address, in German capitals (DIN 5008): "ÖSTERREICH" */
export function countryLine(value: unknown): string {
  const code = countryCode(value)
  if (!/^[A-Z]{2}$/.test(code)) return String(value ?? '').trim().toUpperCase()
  try {
    const name = new Intl.DisplayNames(['de'], { type: 'region' }).of(code)
    return (name || code).toUpperCase()
  } catch {
    return code
  }
}
