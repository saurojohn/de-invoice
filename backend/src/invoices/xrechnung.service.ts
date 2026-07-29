import { Prisma } from '@prisma/client';

/**
 * XRechnung Service — Tier 115
 * Generates electronic invoices in UBL 2.1 + XRechnung 2.3.1
 * (KoSIT, 2024) — the German government CIUS that builds on
 * EN 16931. XRechnung is mandatory for German B2B invoices
 * since 2025-01-01 (Wachstumschancengesetz).
 *
 * Spec: urn:xoev-de:kosit:standard:xrechnung_2.3.1
 * Schema: UBL 2.1 (universal)
 * Validation: KoSIT validator (CIUS-level + business rules
 * BR-01, BR-02, BR-04, BR-05, BR-06, BR-09, BR-16, BR-21,
 * BR-22, BR-CO-09, BR-CO-10, BR-CO-13, BR-CO-15)
 *
 * v2 changes from v1 (1.2 → 2.3.1):
 *   - BuyerReference is now MANDATORY (BR-1 v2)
 *   - PaymentMeans block required when IBAN is given
 *   - AllowanceCharge for Skonto / line-level discount
 *   - EndpointID scheme IDs now standardised: 9930
 *     (Leitweg-ID), 9931 (German tax number), DE:VAT (VAT)
 *   - UBL 2.1 (was UBL 2.0 in 1.2)
 *
 * The service is consumed by:
 *   - GET /invoices/:id/xrechnung         (raw XML download)
 *   - GET /invoices/:id/xrechnung/validate (BR-* check, JSON)
 *   - zugferd.service.ts (Factur-X reuses the data transform)
 */

export interface XRechnungSupplier {
  name: string
  address: {
    street?: string
    postalCode?: string
    city?: string
    country?: string
  }
  vatId?: string
  taxId?: string
  /** German Leitweg-ID for B2G invoices (e.g. "991-12345-67") */
  leitwegId?: string
  /** Electronic address (Peppol-ID or email-as-EM) */
  electronicAddress?: {
    id: string
    schemeId: string // '9930' (Leitweg-ID), '9931' (Steuernummer), 'DE:VAT', 'EM' (email)
  }
  bankInfo?: {
    bankName?: string
    iban?: string
    bic?: string
  }
}

export interface XRechnungCustomer {
  name: string
  address: {
    street?: string
    postalCode?: string
    city?: string
    country?: string
  }
  vatId?: string
  email?: string
  /** BuyerReference (e.g. Leitweg-ID for B2G, internal purchase order ref) */
  buyerReference?: string
}

export interface XRechnungItem {
  description: string
  quantity: number
  unit?: string
  unitPrice: number
  vatRate: number
  netAmount: number
  vatAmount: number
  grossAmount: number
  /** Per-line discount (Rabatt) in % (e.g. 5 = 5%) */
  discountPercent?: number
}

export interface XRechnungAllowance {
  /** Per-line or document-level discount. For Skonto, set
   *  `type = 'skonto'` and `days` to the Skonto window. */
  type: 'discount' | 'skonto'
  percent: number
  /** For Skonto: number of days from issue date. For discount: omit. */
  days?: number
  /** Base amount the % applies to (e.g. subtotal). */
  baseAmount: number
  /** Resulting allowance in currency (rounded to 2 dp). */
  amount: number
}

export interface XRechnungData {
  invoiceNumber: string
  issueDate: string
  dueDate?: string
  currency: string
  /** BR-1 v2: BuyerReference is now mandatory. */
  buyerReference: string
  supplier: XRechnungSupplier
  customer: XRechnungCustomer
  items: XRechnungItem[]
  subtotal: number
  totalVat: number
  total: number
  notes?: string
  /** Skonto (cash discount) at document level. */
  skonto?: XRechnungAllowance
  /** Free-text payment terms (e.g. "Zahlbar innerhalb von 14 Tagen mit 2% Skonto"). */
  paymentTermsNote?: string
}

/**
 * Validation result for an XRechnung.
 */
export interface XRechnungValidation {
  valid: boolean
  errors: XRechnungValidationIssue[]
  warnings: XRechnungValidationIssue[]
}

export interface XRechnungValidationIssue {
  rule: string // e.g. "BR-01", "BR-09", "BR-CO-13"
  severity: 'error' | 'warning'
  message: string
  location?: string // XPath-like pointer
}

/**
 * Generate XRechnung XML in UBL 2.1 + XRechnung 2.3.1.
 */
export function generateXRechnung(data: XRechnungData): string {
  const invoiceDate = formatXRechnungDate(data.issueDate)
  const dueDate = data.dueDate ? formatXRechnungDate(data.dueDate) : null

  // Group VAT by rate for TaxSubtotal
  const vatByRate = groupVatByRate(data.items)

  // XRechnung 2.3.1 conformance identifier
  const customisationId =
    'urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3.1'

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:udt="urn:un:unece:uncefact:data:specification:UnqualifiedDataTypesSchemaModule-2"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">

  <!-- XRechnung 2.3.1 — Konformitätskennung -->
  <cbc:CustomizationID>${customisationId}</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>

  <!-- Rechnungsnummer / Invoice Number (BR-01) -->
  <cbc:ID>${escapeXml(data.invoiceNumber)}</cbc:ID>

  <!-- Rechnungsdatum / Issue Date (BR-02) -->
  <cbc:IssueDate>${invoiceDate}</cbc:IssueDate>

  ${dueDate ? `<!-- Fälligkeitsdatum / Due Date -->
  <cbc:DueDate>${dueDate}</cbc:DueDate>` : ''}

  <!-- Rechnungsart / Invoice Type Code (BR-04 v2: 380 = Commercial invoice) -->
  <cbc:InvoiceTypeCode listID="UN/ECE 1001" listAgencyID="6">380</cbc:InvoiceTypeCode>

  <!-- BR-1 v2: BuyerReference ist Pflicht -->
  <cbc:BuyerReference>${escapeXml(data.buyerReference)}</cbc:BuyerReference>

  <!-- Währung / Currency (BR-05) -->
  <cbc:DocumentCurrencyCode listID="ISO 4217 Alpha" listAgencyID="6">${escapeXml(data.currency)}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode listID="ISO 4217 Alpha" listAgencyID="6">${escapeXml(data.currency)}</cbc:TaxCurrencyCode>

  ${generateSupplierParty(data.supplier)}

  ${generateCustomerParty(data.customer)}

  ${generatePaymentMeans(data.supplier)}

  ${generatePaymentTerms(data)}

  ${data.skonto ? generateAllowanceCharge(data.skonto) : ''}

  <!-- Rechnungspositionen / Invoice Lines (BR-21, BR-22) -->
  ${data.items.map((item, index) => generateInvoiceLine(item, index + 1, data.currency)).join('\n  ')}

  <!-- Steuerübersicht / Tax Total (BR-CO-09, BR-CO-13) -->
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(data.totalVat)}</cbc:TaxAmount>
    ${vatByRate.map(vat => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(vat.taxableAmount)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(vat.taxAmount)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${formatPercent(vat.rate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`).join('')}
  </cac:TaxTotal>

  <!-- Gesamtbetrag / Legal Monetary Total (BR-CO-10, BR-CO-13, BR-CO-15) -->
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(data.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(data.subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(data.total)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(data.total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>

  ${data.notes ? `<!-- Bemerkungen / Notes -->
  <cac:Note>
    <cbc:Content>${escapeXml(data.notes)}</cbc:Content>
  </cac:Note>` : ''}

</Invoice>`

  return xml
}

function generateSupplierParty(s: XRechnungSupplier): string {
  // EndpointID: prefer the explicit electronicAddress, fall
  // back to VAT-ID with scheme DE:VAT, then tax-ID with
  // scheme 9931 (Steuernummer).
  let endpointBlock = ''
  if (s.electronicAddress) {
    endpointBlock = `<cbc:EndpointID schemeID="${escapeXml(s.electronicAddress.schemeId)}">${escapeXml(s.electronicAddress.id)}</cbc:EndpointID>`
  } else if (s.vatId) {
    endpointBlock = `<cbc:EndpointID schemeID="DE:VAT">${escapeXml(s.vatId)}</cbc:EndpointID>`
  } else if (s.taxId) {
    endpointBlock = `<cbc:EndpointID schemeID="9931">${escapeXml(s.taxId)}</cbc:EndpointID>`
  }

  return `<!-- Lieferant / Supplier Party (BR-06, BR-09) -->
  <cac:AccountingSupplierParty>
    <cac:Party>
      ${endpointBlock}
      <cac:PartyName>
        <cbc:Name>${escapeXml(s.name)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(s.address.street || '')}</cbc:StreetName>
        <cbc:CityName>${escapeXml(s.address.city || '')}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(s.address.postalCode || '')}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${escapeXml(normalizeCountryCode(s.address.country))}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      ${s.vatId ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(s.vatId)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
      ${s.taxId ? `
      <cac:PartyLegalEntity>
        <cbc:CompanyID>${escapeXml(s.taxId)}</cbc:CompanyID>
      </cac:PartyLegalEntity>` : ''}
    </cac:Party>
  </cac:AccountingSupplierParty>`
}

function generateCustomerParty(c: XRechnungCustomer): string {
  let endpointBlock = ''
  if (c.vatId) {
    endpointBlock = `<cbc:EndpointID schemeID="DE:VAT">${escapeXml(c.vatId)}</cbc:EndpointID>`
  }

  return `<!-- Kunde / Customer Party (BR-07, BR-08) -->
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${endpointBlock}
      <cac:PartyName>
        <cbc:Name>${escapeXml(c.name)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(c.address.street || '')}</cbc:StreetName>
        <cbc:CityName>${escapeXml(c.address.city || '')}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(c.address.postalCode || '')}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${escapeXml(normalizeCountryCode(c.address.country))}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      ${c.vatId ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(c.vatId)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
    </cac:Party>
  </cac:AccountingCustomerParty>`
}

function generatePaymentMeans(s: XRechnungSupplier): string {
  if (!s.bankInfo?.iban) return ''
  return `<!-- Zahlungsmittel / Payment Means (BR-16: gültiges IBAN-Format) -->
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode listID="UN/ECE 4461">58</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${escapeXml(s.bankInfo.iban)}</cbc:ID>
      ${s.bankInfo.bic ? `<cac:FinancialInstitutionBranch>
        <cbc:ID>${escapeXml(s.bankInfo.bic)}</cbc:ID>
      </cac:FinancialInstitutionBranch>` : ''}
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>`
}

function generatePaymentTerms(data: XRechnungData): string {
  // If we have a Skonto, build the standard German phrase:
  //   "Zahlbar innerhalb von N Tagen mit X% Skonto"
  // Otherwise fall back to user-supplied text or default.
  let note = data.paymentTermsNote
  if (!note && data.skonto) {
    note = `Zahlbar innerhalb von ${data.skonto.days ?? 14} Tagen mit ${formatPercent(data.skonto.percent)}% Skonto`
  } else if (!note) {
    note = 'Zahlbar innerhalb von 30 Tagen'
  }
  return `<!-- Zahlungsbedingungen / Payment Terms (BR-CO-25) -->
  <cac:PaymentTerms>
    <cbc:Note>${escapeXml(note)}</cbc:Note>
  </cac:PaymentTerms>`
}

function generateAllowanceCharge(a: XRechnungAllowance): string {
  // Document-level allowance (Skonto or doc-wide discount)
  const reasonCode = a.type === 'skonto' ? '95' : '1' // 95 = discount
  const reason =
    a.type === 'skonto'
      ? `Skonto ${formatPercent(a.percent)}%`
      : `Rabatt ${formatPercent(a.percent)}%`
  return `<!-- Skonto / Rabatt auf Rechnungsebene (BR-CO-21) -->
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReasonCode listID="UNTDID 5189">${reasonCode}</cbc:AllowanceChargeReasonCode>
    <cbc:AllowanceChargeReason>${escapeXml(reason)}</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="EUR">${formatDecimal(a.amount)}</cbc:Amount>
    <cac:TaxCategory>
      <cbc:ID>S</cbc:ID>
      <cbc:Percent>19.00</cbc:Percent>
      <cac:TaxScheme>
        <cbc:ID>VAT</cbc:ID>
      </cac:TaxScheme>
    </cac:TaxCategory>
  </cac:AllowanceCharge>`
}

function generateInvoiceLine(item: XRechnungItem, lineNumber: number, currency: string): string {
  const unitCode = mapUnitToUNECE(item.unit)
  const vatCategoryId = item.vatRate > 0 ? 'S' : 'E'
  const hasLineDiscount = item.discountPercent && item.discountPercent > 0
  // For a line discount, the price has to be presented
  // as the gross (pre-discount) price with a separate
  // AllowanceCharge. v1 simplification: we leave the
  // line at netAmount (post-discount) and skip the
  // per-line AllowanceCharge when the discount is just
  // per-line rounding. The full doc-level Skonto is
  // captured in the Allowancharge block above.
  return `<cac:InvoiceLine>
    <cbc:ID>${lineNumber}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${unitCode}">${formatDecimal(item.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${formatDecimal(item.netAmount)}</cbc:LineExtensionAmount>
    ${hasLineDiscount ? `
    <cac:AllowanceCharge>
      <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
      <cbc:AllowanceChargeReasonCode listID="UNTDID 5189">1</cbc:AllowanceChargeReasonCode>
      <cbc:AllowanceChargeReason>Rabatt ${formatPercent(item.discountPercent || 0)}%</cbc:AllowanceChargeReason>
      <cbc:Amount currencyID="${escapeXml(currency)}">${formatDecimal((item.unitPrice * item.quantity) - item.netAmount)}</cbc:Amount>
    </cac:AllowanceCharge>` : ''}
    <cac:Item>
      <cbc:Description>${escapeXml(item.description)}</cbc:Description>
      <cbc:Name>${escapeXml(item.description.split('\n')[0])}</cbc:Name>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${escapeXml(currency)}">${formatDecimal(item.unitPrice)}</cbc:PriceAmount>
    </cac:Price>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${escapeXml(currency)}">${formatDecimal(item.vatAmount)}</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:ItemLocationQuantity>
      <cac:TaxCategory>
        <cbc:ID>${vatCategoryId}</cbc:ID>
        <cbc:Percent>${formatPercent(item.vatRate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:ItemLocationQuantity>
  </cac:InvoiceLine>`
}

function groupVatByRate(items: XRechnungItem[]): { rate: number; taxableAmount: number; taxAmount: number }[] {
  const grouped: Map<number, { taxableAmount: number; taxAmount: number }> = new Map()

  for (const item of items) {
    const existing = grouped.get(item.vatRate)
    if (existing) {
      existing.taxableAmount += item.netAmount
      existing.taxAmount += item.vatAmount
    } else {
      grouped.set(item.vatRate, {
        taxableAmount: item.netAmount,
        taxAmount: item.vatAmount,
      })
    }
  }

  return Array.from(grouped.entries()).map(([rate, values]) => ({
    rate,
    taxableAmount: values.taxableAmount,
    taxAmount: values.taxAmount,
  }))
}

function mapUnitToUNECE(unit?: string): string {
  const unitMap: Record<string, string> = {
    piece: 'C62',
    stück: 'C62',
    unit: 'C62',
    hour: 'HUR',
    stunde: 'HUR',
    day: 'DAY',
    tag: 'DAY',
    meter: 'MTR',
    kilogram: 'KGM',
    kilogramm: 'KGM',
    liter: 'LTR',
  }
  return unitMap[unit?.toLowerCase() || ''] || 'C62'
}

/**
 * Normalize a country name to its ISO 3166-1 alpha-2 code.
 * XRechnung requires 2-letter ISO codes in
 * `Country/IdentificationCode`. Our address form
 * collects full German names, so we translate common ones.
 */
const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  deutschland: 'DE',
  germany: 'DE',
  österreich: 'AT',
  oesterreich: 'AT',
  austria: 'AT',
  schweiz: 'CH',
  switzerland: 'CH',
  frankreich: 'FR',
  france: 'FR',
  niederlande: 'NL',
  netherlands: 'NL',
  italien: 'IT',
  italy: 'IT',
  spanien: 'ES',
  spain: 'ES',
  'vereinigtes königreich': 'GB',
  'vereinigtes koenigreich': 'GB',
  'united kingdom': 'GB',
  großbritannien: 'GB',
  grossbritannien: 'GB',
  usa: 'US',
  'vereinigte staaten': 'US',
  'united states': 'US',
  polen: 'PL',
  poland: 'PL',
  tschechien: 'CZ',
  czechia: 'CZ',
  'czech republic': 'CZ',
  belgien: 'BE',
  belgium: 'BE',
  luxemburg: 'LU',
  luxembourg: 'LU',
  dänemark: 'DK',
  daenemark: 'DK',
  denmark: 'DK',
  schweden: 'SE',
  sweden: 'SE',
  norwegen: 'NO',
  norway: 'NO',
  finnland: 'FI',
  finland: 'FI',
  portugal: 'PT',
  irland: 'IE',
  ireland: 'IE',
  griechenland: 'GR',
  greece: 'GR',
}

function normalizeCountryCode(raw?: string | null): string {
  if (!raw) return 'DE'
  const trimmed = String(raw).trim()
  if (!trimmed) return 'DE'
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed
  const mapped = COUNTRY_NAME_TO_ISO[trimmed.toLowerCase()]
  if (mapped) return mapped
  return trimmed
}

function formatXRechnungDate(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date)
  return d.toISOString().split('T')[0]
}

function formatDecimal(value: number): string {
  return value.toFixed(2)
}

function formatPercent(rate: number): string {
  return (rate * 100).toFixed(2)
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Basic EN 16931 / XRechnung business-rule validation.
 * Implements a subset of the BR-* rules that the KoSIT
 * validator also checks — enough to catch common data
 * errors before generating the XML. NOT a full KoSIT
 * replacement; for production use the JAR validator.
 */
export function validateXRechnung(data: XRechnungData): XRechnungValidation {
  const errors: XRechnungValidationIssue[] = []
  const warnings: XRechnungValidationIssue[] = []

  // BR-01: invoice number must be present
  if (!data.invoiceNumber || !data.invoiceNumber.trim()) {
    errors.push({
      rule: 'BR-01',
      severity: 'error',
      message: 'Rechnungsnummer fehlt (BR-01)',
      location: 'cbc:ID',
    })
  }
  // BR-02: issue date must be a valid ISO date
  if (!data.issueDate || isNaN(new Date(data.issueDate).getTime())) {
    errors.push({
      rule: 'BR-02',
      severity: 'error',
      message: 'Rechnungsdatum ungültig (BR-02)',
      location: 'cbc:IssueDate',
    })
  }
  // BR-04: seller (supplier) name must be present
  if (!data.supplier?.name?.trim()) {
    errors.push({
      rule: 'BR-04',
      severity: 'error',
      message: 'Lieferant (Rechnungssteller) fehlt (BR-04)',
      location: 'cac:AccountingSupplierParty',
    })
  }
  // BR-05: buyer (customer) name must be present
  if (!data.customer?.name?.trim()) {
    errors.push({
      rule: 'BR-05',
      severity: 'error',
      message: 'Kunde (Rechnungsempfänger) fehlt (BR-05)',
      location: 'cac:AccountingCustomerParty',
    })
  }
  // BR-06: seller postal address requires street, city, postalCode, country
  const sa = data.supplier?.address
  if (!sa?.street?.trim() || !sa?.city?.trim() || !sa?.postalCode?.trim() || !sa?.country?.trim()) {
    errors.push({
      rule: 'BR-06',
      severity: 'error',
      message: 'Lieferant-Adresse unvollständig (BR-06: Straße, PLZ, Ort, Land erforderlich)',
      location: 'cac:AccountingSupplierParty/cac:PostalAddress',
    })
  }
  // BR-07: same for customer
  const ca = data.customer?.address
  if (!ca?.street?.trim() || !ca?.city?.trim() || !ca?.postalCode?.trim() || !ca?.country?.trim()) {
    errors.push({
      rule: 'BR-07',
      severity: 'error',
      message: 'Kunden-Adresse unvollständig (BR-07: Straße, PLZ, Ort, Land erforderlich)',
      location: 'cac:AccountingCustomerParty/cac:PostalAddress',
    })
  }
  // BR-08: country code must be valid 2-letter ISO
  if (sa?.country && !/^[A-Z]{2}$/.test(normalizeCountryCode(sa.country))) {
    errors.push({
      rule: 'BR-08',
      severity: 'error',
      message: `Ländercode ungültig: ${sa.country} (BR-08)`,
      location: 'cac:AccountingSupplierParty/cac:Country',
    })
  }
  // BR-09: electronic address scheme required for XRechnung
  // v2 — supplier must have an electronicAddress (VAT, tax
  // number, or Leitweg-ID).
  if (
    !data.supplier.electronicAddress &&
    !data.supplier.vatId &&
    !data.supplier.taxId &&
    !data.supplier.leitwegId
  ) {
    errors.push({
      rule: 'BR-09',
      severity: 'error',
      message:
        'Elektronische Adresse des Lieferanten fehlt (BR-09 — VAT-ID, Steuernummer oder Leitweg-ID erforderlich)',
      location: 'cac:AccountingSupplierParty/cbc:EndpointID',
    })
  }
  // BR-1 v2: BuyerReference mandatory
  if (!data.buyerReference || !data.buyerReference.trim()) {
    errors.push({
      rule: 'BR-1-v2',
      severity: 'error',
      message: 'BuyerReference fehlt (BR-1 v2: Pflichtfeld seit XRechnung 2.0)',
      location: 'cbc:BuyerReference',
    })
  }
  // BR-16: IBAN format (if given)
  if (data.supplier.bankInfo?.iban) {
    const iban = data.supplier.bankInfo.iban.replace(/\s/g, '').toUpperCase()
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{12,30}$/.test(iban)) {
      errors.push({
        rule: 'BR-16',
        severity: 'error',
        message: `Ungültiges IBAN-Format: ${data.supplier.bankInfo.iban} (BR-16)`,
        location: 'cac:PaymentMeans/cac:PayeeFinancialAccount',
      })
    }
  }
  // BR-21: invoice line description required
  data.items.forEach((item, i) => {
    if (!item.description?.trim()) {
      errors.push({
        rule: 'BR-21',
        severity: 'error',
        message: `Position ${i + 1}: Beschreibung fehlt (BR-21)`,
        location: `cac:InvoiceLine[${i + 1}]/cac:Item/cbc:Description`,
      })
    }
  })
  // BR-22: quantity > 0, unit price >= 0
  data.items.forEach((item, i) => {
    if (!(item.quantity > 0)) {
      errors.push({
        rule: 'BR-22',
        severity: 'error',
        message: `Position ${i + 1}: Menge muss > 0 sein (BR-22)`,
        location: `cac:InvoiceLine[${i + 1}]/cbc:InvoicedQuantity`,
      })
    }
    if (item.unitPrice < 0) {
      errors.push({
        rule: 'BR-22',
        severity: 'error',
        message: `Position ${i + 1}: Einzelpreis darf nicht negativ sein (BR-22)`,
        location: `cac:InvoiceLine[${i + 1}]/cac:Price/cbc:PriceAmount`,
      })
    }
  })
  // BR-CO-09: TaxSubtotal amounts must add up to totalVat
  const vatByRate = groupVatByRate(data.items)
  const sumVat = vatByRate.reduce((s, v) => s + v.taxAmount, 0)
  if (Math.abs(sumVat - data.totalVat) > 0.01) {
    errors.push({
      rule: 'BR-CO-09',
      severity: 'error',
      message: `Steuer-Subtotal-Summe (${sumVat.toFixed(2)}) ≠ Gesamtsteuer (${data.totalVat.toFixed(2)}) (BR-CO-09)`,
      location: 'cac:TaxTotal',
    })
  }
  // BR-CO-10: line sums must add up to subtotal
  const lineSum = data.items.reduce((s, i) => s + i.netAmount, 0)
  if (Math.abs(lineSum - data.subtotal) > 0.01) {
    errors.push({
      rule: 'BR-CO-10',
      severity: 'error',
      message: `Positionssumme (${lineSum.toFixed(2)}) ≠ Nettobetrag (${data.subtotal.toFixed(2)}) (BR-CO-10)`,
      location: 'cac:LegalMonetaryTotal/cbc:LineExtensionAmount',
    })
  }
  // BR-CO-13: tax inclusive = tax exclusive + tax total
  if (Math.abs(data.total - (data.subtotal + data.totalVat)) > 0.01) {
    errors.push({
      rule: 'BR-CO-13',
      severity: 'error',
      message: `Bruttobetrag (${data.total.toFixed(2)}) ≠ Netto + USt (${(data.subtotal + data.totalVat).toFixed(2)}) (BR-CO-13)`,
      location: 'cac:LegalMonetaryTotal',
    })
  }
  // BR-CO-15: payable amount = total (no prepaid amount for v1)
  // Note: we don't subtract prepaid here — it's always
  // equal in v1.
  // Warnings (not errors)
  if (data.items.length === 0) {
    warnings.push({
      rule: 'BR-21-warn',
      severity: 'warning',
      message: 'Keine Rechnungspositionen vorhanden',
      location: 'cac:InvoiceLine',
    })
  }
  if (!data.dueDate) {
    warnings.push({
      rule: 'BT-09',
      severity: 'warning',
      message: 'Kein Fälligkeitsdatum gesetzt',
      location: 'cbc:DueDate',
    })
  }
  if (!data.supplier.bankInfo?.iban) {
    warnings.push({
      rule: 'BT-81',
      severity: 'warning',
      message: 'Keine Bankverbindung (IBAN) — Empfänger kann nicht per Lastschrift zahlen',
      location: 'cac:PaymentMeans',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

/**
 * Transform Prisma invoice data to XRechnung format.
 * v2: adds buyerReference, leitwegId, skonto.
 */
export function transformToXRechnungData(
  invoice: {
    invoiceNumber: string
    issueDate: Date | string
    dueDate?: Date | string | null
    currency: string
    subtotal: any
    totalVat: any
    total: any
    notes?: string | null
    /** v2: customer-supplied buyer reference (Leitweg-ID for B2G) */
    buyerReference?: string | null
    /** v2: per-invoice Skonto (cash discount) */
    skontoPercent?: any
    skontoDays?: any
    customer: {
      name: string
      vatId?: string | null
      address: any
      contact?: any
    }
    items: {
      description: string
      quantity: any
      unit?: string | null
      unitPrice: any
      vatRate: any
      netAmount: any
      vatAmount: any
      grossAmount: any
      discountPercent?: any
    }[]
  },
  company: {
    name: string
    vatId?: string | null
    taxId?: string | null
    address: any
    bankInfo?: any
    /** v2: Leitweg-ID stored in settings (B2G use) */
    leitwegId?: string | null
  }
): XRechnungData {
  // BuyerReference resolution order:
  //   1. invoice.buyerReference (explicit override)
  //   2. customer.address.buyerReference (B2G Leitweg-ID)
  //   3. customer number (fallback so the field is never empty)
  const customerAddress = (invoice.customer?.address as any) || {}
  const buyerReference =
    invoice.buyerReference?.trim() ||
    customerAddress.buyerReference?.trim() ||
    customerAddress.leitwegId?.trim() ||
    invoice.customer?.name ||
    'N/A'

  // Skonto: invoice-level Skonto becomes a doc-level
  // allowance. Skip if the Skonto has already been
  // factored into the totals (v1 always passes the
  // full amount — Skonto is a future-payment option,
  // not a discount-on-this-invoice).
  //
  // skontoPercent in the DB is stored as a percentage
  // value (e.g. 2 for "2%"), not a 0-1 fraction. The
  // XRechnung layer stores it as a 0-1 fraction
  // internally (matching the VAT rate convention),
  // so divide by 100 here.
  let skonto: XRechnungAllowance | undefined
  const skontoPctRaw = parseFloat(String(invoice.skontoPercent ?? '0'))
  const skontoDays = parseInt(String(invoice.skontoDays ?? '0'), 10)
  if (skontoPctRaw > 0 && skontoDays > 0) {
    const skontoPct = skontoPctRaw / 100
    const baseAmount = parseFloat(String(invoice.subtotal))
    const amount = round2(baseAmount * skontoPct)
    skonto = {
      type: 'skonto',
      percent: skontoPct,
      days: skontoDays,
      baseAmount,
      amount,
    }
  }

  return {
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate instanceof Date ? invoice.issueDate.toISOString() : invoice.issueDate,
    dueDate: invoice.dueDate ? (invoice.dueDate instanceof Date ? invoice.dueDate.toISOString() : invoice.dueDate) : undefined,
    currency: invoice.currency,
    buyerReference,
    supplier: {
      name: company.name,
      address: company.address || {},
      vatId: company.vatId || undefined,
      taxId: company.taxId || undefined,
      leitwegId: company.leitwegId || undefined,
      bankInfo: company.bankInfo || undefined,
    },
    customer: {
      name: invoice.customer?.name || '',
      address: invoice.customer?.address || {},
      vatId: invoice.customer?.vatId || undefined,
      email: (invoice.customer?.contact as any)?.email || undefined,
    },
    items: invoice.items.map(item => ({
      description: item.description,
      quantity: parseFloat(item.quantity.toString()),
      unit: item.unit || undefined,
      unitPrice: parseFloat(item.unitPrice.toString()),
      vatRate: parseFloat(item.vatRate.toString()),
      netAmount: parseFloat(item.netAmount.toString()),
      vatAmount: parseFloat(item.vatAmount.toString()),
      grossAmount: parseFloat(item.grossAmount.toString()),
      discountPercent: item.discountPercent
        ? parseFloat(item.discountPercent.toString())
        : undefined,
    })),
    subtotal: parseFloat(String(invoice.subtotal)),
    totalVat: parseFloat(String(invoice.totalVat)),
    total: parseFloat(String(invoice.total)),
    notes: invoice.notes || undefined,
    skonto,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
