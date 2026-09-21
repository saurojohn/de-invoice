
/**
 * XRechnung Service — Tier 115/116
 * Generates electronic invoices in UBL 2.1 + XRechnung 3.0
 * (KoSIT 2024) — the German government CIUS that builds on
 * EN 16931. XRechnung is mandatory for German B2B invoices
 * since 2025-01-01 (Wachstumschancengesetz).
 *
 * Spec: urn:xeinkauf.de:kosit:xrechnung_3.0 (XRechnung 3.0.2)
 * Schema: UBL 2.1 (universal)
 * Validation: KoSIT validator (CIUS-level + business rules
 * BR-01, BR-02, BR-04, BR-05, BR-06, BR-09, BR-16, BR-21,
 * BR-22, BR-CO-09, BR-CO-10, BR-CO-13, BR-CO-15)
 *
 * v3 changes from v2 (2.3.1 → 3.0):
 *   - New CIUS identifier (urn:xeinkauf.de:kosit:xrechnung_3.0)
 *   - Schematron 2.5.0 enforces additional rules
 *   - Common.sch shared between UBL + CII variants
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
 *     - ?engine=basic (default, fast in-process BR-* check)
 *     - ?engine=kosit  (full KoSIT JAR validation)
 *   - zugferd.service.ts (Factur-X reuses the data transform)
 */

import { invoiceTaxBreakdown } from '../modules/invoice/tax-breakdown'

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
  /** Tier 412: registered name (BT-27) when it differs from the trading name */
  legalName?: string
  /** Tier 412: Handelsregister entry (BT-30) */
  registerEntry?: string
  /** German Leitweg-ID for B2G invoices (e.g. "991-12345-67") */
  leitwegId?: string
  /** Electronic address (Peppol-ID or email-as-EM) */
  electronicAddress?: {
    id: string
    schemeId: string // CEF EAS code: 'EM' (e-mail), '9930' (DE VAT), '0204' (Leitweg-ID); legacy 'DE:VAT' is read as 9930
  }
  bankInfo?: {
    bankName?: string
    iban?: string
    bic?: string
  }
  /** BR-DE-6 / BR-DE-7: Telefonnummer (BT-42) + E-Mail (BT-43) */
  phone?: string
  email?: string
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
  /** German Leitweg-ID for B2G buyer (e.g. "991-12345-67") */
  leitwegId?: string
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
  /** Tier 414: Leistungsdatum (BT-72); the issue date stands in when unset. */
  deliveryDate?: string
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
  /**
   * Tier 412: the invoice's tax treatment and its per-rate breakdown after the
   * invoice discount (tax-breakdown.ts). Optional so callers that build the
   * data by hand keep working; without them the lines are taken as they are.
   */
  euTransaction?: boolean
  reverseCharge?: boolean
  hasDocumentDiscount?: boolean
  taxBreakdown?: Array<{ rate: number; net: number; vat: number }>
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

  // Tier 412: every amount in the document comes from one computation, so the
  // EN 16931 arithmetic rules (BR-CO-10/11/13/14/15, BR-S-08/09) hold by
  // construction. See computeXRechnungTotals.
  const t = computeXRechnungTotals(data)

  // XRechnung 3.0 conformance identifier (current spec, 2024)
  // Replaces the 2.3.1 / 1.2 IDs from earlier versions. The
  // KoSIT Schematron 2.5.0 / XRechnung 3.0.2 rules enforce
  // this exact identifier.
  const customisationId =
    'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0'

  // ──────────────────────────────────────────────────────
  // UBL 2.1 XSD element order (Tier 117 fix).
  // The XSD enforces strict element ordering (xs:sequence).
  // Previous order placed BuyerReference before
  // DocumentCurrencyCode and Note at the end — both
  // cvc-complex-type.2.4.a violations. Now we follow
  // the UBL-Invoice-2.1.xsd sequence exactly.
  // ──────────────────────────────────────────────────────
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:udt="urn:un:unece:uncefact:data:specification:UnqualifiedDataTypesSchemaModule-2"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">

  <!-- UBL 2.1 — Schema-Version (UBL 2.1 XSD compliance) -->
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>

  <!-- XRechnung 3.0 — Konformitätskennung (KoSIT 2024) -->
  <cbc:CustomizationID>${customisationId}</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>

  <!-- Rechnungsnummer / Invoice Number (BR-01) -->
  <cbc:ID>${escapeXml(data.invoiceNumber)}</cbc:ID>

  <!-- Rechnungsdatum / Issue Date (BR-02) -->
  <cbc:IssueDate>${invoiceDate}</cbc:IssueDate>

  ${dueDate ? `<!-- Fälligkeitsdatum / Due Date -->
  <cbc:DueDate>${dueDate}</cbc:DueDate>` : ''}

  <!-- Rechnungsart / Invoice Type Code (BR-04 v2: 380 = Commercial invoice).
       Tier 412: no listID / listAgencyID — EN 16931 flags both (UBL-CR-656,
       UBL-DT-28). -->
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>

  ${data.notes ? `<!-- Bemerkungen / Notes (XSD position: after InvoiceTypeCode) -->
  <cbc:Note>${escapeXml(data.notes)}</cbc:Note>` : ''}

  <!-- Währung / Currency (BR-05) -->
  <cbc:DocumentCurrencyCode>${escapeXml(data.currency)}</cbc:DocumentCurrencyCode>
  <!-- BR-53: TaxCurrencyCode absichtlich weggelassen (nur nötig wenn
       != DocumentCurrencyCode). Wir setzen aktuell keine
       abweichende VAT-Währung. -->

  <!-- Tier 412: LineCountNumeric removed — not part of EN 16931 (UBL-CR-011). -->

  <!-- BR-1 v2: BuyerReference ist Pflicht -->
  <cbc:BuyerReference>${escapeXml(data.buyerReference)}</cbc:BuyerReference>

  <!-- Leistungszeitraum / Invoice Period (BR-DE-TMP-32 / BG-14).
       Für Service-Rechnungen ohne separate Lieferperiode setzen
       wir den Leistungszeitraum auf das Rechnungsdatum. XSD-Position:
       nach BuyerReference, vor SupplierParty. -->
  <cac:InvoicePeriod>
    <cbc:StartDate>${formatXRechnungDate(data.deliveryDate ?? data.issueDate)}</cbc:StartDate>
    <cbc:EndDate>${formatXRechnungDate(data.deliveryDate ?? data.issueDate)}</cbc:EndDate>
  </cac:InvoicePeriod>

  ${generateSupplierParty(data.supplier)}

  ${generateCustomerParty(data.customer)}

  ${t.categories.includes('K') ? generateDelivery(data.customer) : ''}

  ${generatePaymentMeans(data.supplier)}

  ${generatePaymentTerms(data)}

  ${t.allowances.map((a) => generateDocumentAllowance(a, data.currency)).join('\n  ')}

  <!-- Steuerübersicht / Tax Total (BR-CO-14, BR-S-08/09) -->
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${escapeXml(data.currency)}">${formatCents(t.taxTotal)}</cbc:TaxAmount>
    ${t.subtotals.map((v) => `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${escapeXml(data.currency)}">${formatCents(v.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${escapeXml(data.currency)}">${formatCents(v.tax)}</cbc:TaxAmount>
      ${taxCategoryXml(v.category, v.rate, true)}
    </cac:TaxSubtotal>`).join('')}
  </cac:TaxTotal>

  <!-- Gesamtbetrag / Legal Monetary Total (BR-CO-10, BR-CO-11, BR-CO-13, BR-CO-15, BR-CO-16) -->
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(data.currency)}">${formatCents(t.lineExtension)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(data.currency)}">${formatCents(t.taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(data.currency)}">${formatCents(t.taxInclusive)}</cbc:TaxInclusiveAmount>
    ${t.allowanceTotal !== 0 ? `<cbc:AllowanceTotalAmount currencyID="${escapeXml(data.currency)}">${formatCents(t.allowanceTotal)}</cbc:AllowanceTotalAmount>` : ''}
    <cbc:PayableAmount currencyID="${escapeXml(data.currency)}">${formatCents(t.payable)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>

  <!-- Rechnungspositionen / Invoice Lines (BR-21, BR-22) — XSD position: last element group -->
  ${data.items.map((item, index) => generateInvoiceLine(item, index + 1, data.currency, t.lineNets[index], t.categoryOf(item.vatRate))).join('\n  ')}

</Invoice>`

  return xml
}

function generateSupplierParty(s: XRechnungSupplier): string {
  // EndpointID: prefer the explicit electronicAddress, fall
  // back to VAT-ID with scheme DE:VAT, then tax-ID with
  // scheme 9931 (Steuernummer).
  // Tier 412: the scheme must be a CEF EAS code (BR-CL-25). "DE:VAT" is not
  // one, and 9931 — used here as "Steuernummer" — is the Estonian VAT number.
  // E-mail (EM) is what XRechnung expects for BT-34; a German VAT id is 9930.
  let endpointBlock = ''
  const explicitScheme = s.electronicAddress?.schemeId === 'DE:VAT' ? '9930' : s.electronicAddress?.schemeId
  if (s.electronicAddress && explicitScheme && explicitScheme !== '9931') {
    endpointBlock = `<cbc:EndpointID schemeID="${escapeXml(explicitScheme)}">${escapeXml(s.electronicAddress.id)}</cbc:EndpointID>`
  } else if (s.email) {
    endpointBlock = `<cbc:EndpointID schemeID="EM">${escapeXml(s.email)}</cbc:EndpointID>`
  } else if (s.vatId && vatEasScheme(s.vatId)) {
    endpointBlock = `<cbc:EndpointID schemeID="${vatEasScheme(s.vatId)}">${escapeXml(s.vatId)}</cbc:EndpointID>`
  }

  return `<!-- Lieferant / Supplier Party (BR-06, BR-09, BR-DE-2) -->
  <cac:AccountingSupplierParty>
    <cac:Party>
      ${endpointBlock}
      ${!s.vatId && !s.registerEntry && s.taxId ? `
      <!-- BR-CO-26 wants BT-29, BT-30 or BT-31. A seller with only a
           Steuernummer (no USt-IdNr., no Handelsregister) has nothing else to
           give, so it doubles as the seller identifier. Tier 412. -->
      <cac:PartyIdentification>
        <cbc:ID>${escapeXml(s.taxId)}</cbc:ID>
      </cac:PartyIdentification>` : ''}
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
      <!-- BT-32 Steuernummer (Tier 412): a standard-rated line needs BT-31 or
           BT-32 (BR-S-02); the tax scheme is "FC", not VAT. -->
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(s.taxId)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>FC</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
      <!-- BR-06: Seller name (BT-27) is PartyLegalEntity/RegistrationName;
           PartyName above is the trading name (BT-28). Tier 412. -->
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(s.legalName || s.name)}</cbc:RegistrationName>
        ${s.registerEntry ? `<cbc:CompanyID>${escapeXml(s.registerEntry)}</cbc:CompanyID>` : ''}
      </cac:PartyLegalEntity>
      <!-- BR-DE-2/6/7 (XRechnung Pflicht): Seller Contact (BG-6).
           Pflicht: Name + Telefon (BT-42) + E-Mail (BT-43).
           Wir nutzen den Firmennamen als Ansprechpartner-Fallback. -->
      <cac:Contact>
        <cbc:Name>${escapeXml(s.name)}</cbc:Name>
        ${s.phone ? `<cbc:Telephone>${escapeXml(s.phone)}</cbc:Telephone>` : ''}
        ${s.email ? `<cbc:ElectronicMail>${escapeXml(s.email)}</cbc:ElectronicMail>` : ''}
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>`
}

function generateCustomerParty(c: XRechnungCustomer): string {
  // BR-DE-TMP-1: Buyer electronic address MUST be provided.
  // Prefer VAT-ID (scheme DE:VAT), fall back to Leitweg-ID
  // (scheme 9930) for B2G buyers.
  // Tier 412: CEF EAS codes (BR-CL-25) — Leitweg-ID is 0204 (9930 is the
  // German VAT number), then e-mail, then the VAT id under its country's code.
  // XRechnung requires the buyer's electronic address (PEPPOL-EN16931-R010).
  let endpointBlock = ''
  if (c.leitwegId) {
    endpointBlock = `<cbc:EndpointID schemeID="0204">${escapeXml(c.leitwegId)}</cbc:EndpointID>`
  } else if (c.email) {
    endpointBlock = `<cbc:EndpointID schemeID="EM">${escapeXml(c.email)}</cbc:EndpointID>`
  } else if (c.vatId && vatEasScheme(c.vatId)) {
    endpointBlock = `<cbc:EndpointID schemeID="${vatEasScheme(c.vatId)}">${escapeXml(c.vatId)}</cbc:EndpointID>`
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
      <!-- BR-07: Buyer name (BT-44). Tier 412. -->
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(c.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`
}

/**
 * Tier 412: the CEF EAS code for a VAT number, by its country prefix. Only
 * countries whose VAT number has its own code; Italy, Sweden, Finland and
 * Denmark use register-based codes and get none.
 */
const VAT_EAS: Record<string, string> = {
  AT: '9914', BE: '9925', BG: '9926', CH: '9927', CY: '9928', CZ: '9929',
  DE: '9930', EE: '9931', GB: '9932', EL: '9933', GR: '9933', HR: '9934',
  IE: '9935', LT: '9937', LU: '9938', LV: '9939', MT: '9943', NL: '9944',
  PL: '9945', PT: '9946', RO: '9947', SI: '9949', SK: '9950', ES: '9920',
  HU: '9910', FR: '9957',
}

export function vatEasScheme(vatId: string): string | undefined {
  return VAT_EAS[vatId.trim().slice(0, 2).toUpperCase()]
}

/**
 * Tier 412: BR-IC-12 — an intra-community supply names where the goods went;
 * XRechnung then wants the full address (BR-DE-10/11). The buyer's address is
 * the only one the invoice knows.
 */
function generateDelivery(c: XRechnungCustomer): string {
  return `<cac:Delivery>
    <cac:DeliveryLocation>
      <cac:Address>
        <cbc:StreetName>${escapeXml(c.address.street || '')}</cbc:StreetName>
        <cbc:CityName>${escapeXml(c.address.city || '')}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(c.address.postalCode || '')}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${escapeXml(normalizeCountryCode(c.address.country))}</cbc:IdentificationCode>
        </cac:Country>
      </cac:Address>
    </cac:DeliveryLocation>
  </cac:Delivery>`
}

function generatePaymentMeans(s: XRechnungSupplier): string {
  if (!s.bankInfo?.iban) return ''
  return `<!-- Zahlungsmittel / Payment Means (BR-16: gültiges IBAN-Format) -->
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
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
  // Tier 412: Skonto is a payment term, not an allowance. It used to be a
  // document-level AllowanceCharge that did not reduce the totals (BR-CO-11,
  // BR-S-08). XRechnung carries it as a machine-readable line in this note:
  // #SKONTO#TAGE=n#PROZENT=x.xx# followed by a line break.
  if (data.skonto) {
    const pct = (data.skonto.percent * 100).toFixed(2)
    note = `${note}\n#SKONTO#TAGE=${data.skonto.days ?? 14}#PROZENT=${pct}#\n`
  }
  return `<!-- Zahlungsbedingungen / Payment Terms (BR-CO-25) -->
  <cac:PaymentTerms>
    <cbc:Note>${escapeXml(note)}</cbc:Note>
  </cac:PaymentTerms>`
}

export type TaxCategoryCode = 'S' | 'K' | 'AE' | 'E'

/** Tier 412: exemption reasons for the zero-rated categories (BR-K-10, BR-AE-10, BR-E-10). */
export const EXEMPTION: Record<Exclude<TaxCategoryCode, 'S'>, { code?: string; text: string }> = {
  K: { code: 'VATEX-EU-IC', text: 'Steuerfreie innergemeinschaftliche Lieferung' },
  AE: { code: 'VATEX-EU-AE', text: 'Steuerschuldnerschaft des Leistungsempfängers' },
  E: { text: 'Steuerbefreite Leistung' },
}

function taxCategoryXml(category: TaxCategoryCode, rate: number, withReason: boolean): string {
  const ex = category === 'S' ? undefined : EXEMPTION[category]
  return `<cac:TaxCategory>
        <cbc:ID>${category}</cbc:ID>
        <cbc:Percent>${formatPercent(rate)}</cbc:Percent>
        ${withReason && ex?.code ? `<cbc:TaxExemptionReasonCode>${ex.code}</cbc:TaxExemptionReasonCode>` : ''}
        ${withReason && ex ? `<cbc:TaxExemptionReason>${escapeXml(ex.text)}</cbc:TaxExemptionReason>` : ''}
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>`
}

function generateDocumentAllowance(
  a: { amount: number; category: TaxCategoryCode; rate: number },
  currency: string,
): string {
  // UNTDID 5189 code 95 = Discount. One allowance per VAT category, since each
  // must name the category it reduces (BR-32, BR-S-08).
  return `<!-- Rabatt auf Rechnungsebene (BG-20) -->
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode>
    <cbc:AllowanceChargeReason>Rabatt</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="${escapeXml(currency)}">${formatCents(a.amount)}</cbc:Amount>
    ${taxCategoryXml(a.category, a.rate, false)}
  </cac:AllowanceCharge>`
}

function generateInvoiceLine(
  item: XRechnungItem,
  lineNumber: number,
  currency: string,
  lineNetCents: number,
  category: TaxCategoryCode,
): string {
  const unitCode = mapUnitToUNECE(item.unit)
  // Tier 412: no per-line TaxTotal (UBL-CR-561 — VAT is stated per category in
  // the document's TaxTotal), and the line's category matches the breakdown.
  return `<cac:InvoiceLine>
    <cbc:ID>${lineNumber}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${unitCode}">${formatDecimal(item.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${escapeXml(currency)}">${formatCents(lineNetCents)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Description>${escapeXml(item.description)}</cbc:Description>
      <cbc:Name>${escapeXml(item.description.split('\n')[0])}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${category}</cbc:ID>
        <cbc:Percent>${formatPercent(item.vatRate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${escapeXml(currency)}">${formatDecimal(item.unitPrice)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`
}

export interface XRechnungTotals {
  /** per line, in cents, as LineExtensionAmount (BT-131) */
  lineNets: number[]
  lineExtension: number
  allowances: Array<{ amount: number; category: TaxCategoryCode; rate: number }>
  allowanceTotal: number
  taxExclusive: number
  subtotals: Array<{ rate: number; category: TaxCategoryCode; taxable: number; tax: number }>
  taxTotal: number
  taxInclusive: number
  payable: number
  categories: TaxCategoryCode[]
  categoryOf: (rate: number) => TaxCategoryCode
}

const cents = (n: number) => Math.round(n * 100)

/** Split `total` cents over `weights`; the remainder goes to the largest weight. */
function allocateCents(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (weights.length === 0) return []
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0))
  const parts = weights.map((w) => Math.round((total * w) / sum))
  const drift = total - parts.reduce((a, b) => a + b, 0)
  if (drift !== 0) {
    let largest = 0
    for (let i = 1; i < weights.length; i++) if (Math.abs(weights[i]) > Math.abs(weights[largest])) largest = i
    parts[largest] += drift
  }
  return parts
}

/**
 * Tier 412 — the document's amounts, computed once, in integer cents.
 *
 * EN 16931 checks the arithmetic of the XML itself: line nets sum to BT-106,
 * BT-109 = BT-106 − allowances, BT-110 = Σ category tax, BT-112 = BT-109 +
 * BT-110, and each category's tax = its taxable amount × its rate. The old
 * generator printed the stored invoice totals next to line-derived subtotals,
 * so a discounted invoice contradicted itself (tax subtotal 190, total tax 171)
 * and Skonto appeared as an allowance that reduced nothing.
 *
 * Lines stay undiscounted (EN 16931's line net). A document discount becomes
 * one allowance per VAT category, sized so each category's taxable amount is
 * that category's share of the discounted net (tax-breakdown.ts).
 */
export function computeXRechnungTotals(data: XRechnungData): XRechnungTotals {
  const categoryOf = (rate: number): TaxCategoryCode =>
    rate > 0 ? 'S' : data.euTransaction ? 'K' : data.reverseCharge ? 'AE' : 'E'

  const lineNets = data.items.map((i) => cents(i.netAmount))
  const lineExtension = lineNets.reduce((a, b) => a + b, 0)

  const rates: number[] = []
  const lineByRate = new Map<number, number>()
  data.items.forEach((item, i) => {
    const r = Math.round(item.vatRate * 10000) / 10000
    if (!lineByRate.has(r)) rates.push(r)
    lineByRate.set(r, (lineByRate.get(r) ?? 0) + lineNets[i])
  })
  rates.sort((a, b) => b - a)

  let taxables = rates.map((r) => lineByRate.get(r) ?? 0)
  if (data.hasDocumentDiscount && data.taxBreakdown && data.taxBreakdown.length > 0) {
    const docNet = cents(data.taxBreakdown.reduce((a, b) => a + b.net, 0))
    const weights = rates.map((r) => {
      const b = data.taxBreakdown!.find((x) => Math.abs(x.rate - r) < 1e-6)
      return b ? b.net : 0
    })
    taxables = allocateCents(docNet, weights)
  }

  const allowances = rates
    .map((r, i) => ({ amount: (lineByRate.get(r) ?? 0) - taxables[i], category: categoryOf(r), rate: r }))
    .filter((a) => a.amount !== 0)
  const allowanceTotal = allowances.reduce((a, b) => a + b.amount, 0)
  const taxExclusive = lineExtension - allowanceTotal

  const subtotals = rates.map((r, i) => {
    const category = categoryOf(r)
    const tax = category === 'S' ? Math.round((taxables[i] * r * 10000) / 10000) : 0
    return { rate: r, category, taxable: taxables[i], tax }
  })
  const taxTotal = subtotals.reduce((a, b) => a + b.tax, 0)
  const taxInclusive = taxExclusive + taxTotal
  return {
    lineNets,
    lineExtension,
    allowances,
    allowanceTotal,
    taxExclusive,
    subtotals,
    taxTotal,
    taxInclusive,
    payable: taxInclusive,
    categories: [...new Set(subtotals.map((x) => x.category))],
    categoryOf,
  }
}

export function formatCents(c: number): string {
  const sign = c < 0 ? '-' : ''
  const abs = Math.abs(c)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function mapUnitToUNECE(unit?: string): string {
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

export function normalizeCountryCode(raw?: string | null): string {
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
  // BR-09: electronic address required for XRechnung (BT-34).
  // Tier 412: a Steuernummer or the seller's own Leitweg-ID is not one (the
  // generator used them under invalid schemes); it is the e-mail address or a
  // VAT number with its own EAS code.
  if (
    !data.supplier.electronicAddress &&
    !data.supplier.email &&
    !(data.supplier.vatId && vatEasScheme(data.supplier.vatId))
  ) {
    errors.push({
      rule: 'BR-09',
      severity: 'error',
      message:
        'Elektronische Adresse des Lieferanten fehlt (BR-09 — E-Mail-Adresse oder USt-IdNr. erforderlich)',
      location: 'cac:AccountingSupplierParty/cbc:EndpointID',
    })
  }
  // Tier 412: the buyer's electronic address (BT-49) is mandatory in
  // XRechnung (PEPPOL-EN16931-R010): Leitweg-ID, e-mail or VAT number.
  if (
    !data.customer?.leitwegId &&
    !data.customer?.email &&
    !(data.customer?.vatId && vatEasScheme(data.customer.vatId))
  ) {
    errors.push({
      rule: 'PEPPOL-EN16931-R010',
      severity: 'error',
      message:
        'Elektronische Adresse des Kunden fehlt (BT-49 — Leitweg-ID, E-Mail-Adresse oder USt-IdNr. beim Kunden hinterlegen)',
      location: 'cac:AccountingCustomerParty/cbc:EndpointID',
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
  // Tier 412: BR-CO-09/10/13 used to compare the stored totals with the lines,
  // which a correctly discounted invoice can never satisfy (net + VAT ≠ lines +
  // line VAT). The XML's arithmetic now holds by construction
  // (computeXRechnungTotals); what can still go wrong is the XML disagreeing
  // with the document the customer received.
  const computed = computeXRechnungTotals(data)
  if (Math.abs(computed.payable - Math.round(data.total * 100)) > 1) {
    errors.push({
      rule: 'BR-CO-15',
      severity: 'error',
      message: `XRechnung-Zahlbetrag (${(computed.payable / 100).toFixed(2)}) ≠ Rechnungsbetrag (${data.total.toFixed(2)}) (BR-CO-15)`,
      location: 'cac:LegalMonetaryTotal/cbc:PayableAmount',
    })
  }
  if (Math.abs(computed.taxTotal - Math.round(data.totalVat * 100)) > 1) {
    errors.push({
      rule: 'BR-CO-14',
      severity: 'error',
      message: `XRechnung-Steuerbetrag (${(computed.taxTotal / 100).toFixed(2)}) ≠ ausgewiesene USt (${data.totalVat.toFixed(2)}) (BR-CO-14)`,
      location: 'cac:TaxTotal/cbc:TaxAmount',
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
    deliveryDate?: Date | string | null
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
    /** Tier 412: tax treatment and the invoice discount */
    euTransaction?: boolean | null
    reverseCharge?: boolean | null
    discountPercent?: any
    discountAmount?: any
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
    legalName?: string | null
    registerEntry?: string | null
    address: any
    bankInfo?: any
    /** v2: Leitweg-ID stored in settings (B2G use) */
    leitwegId?: string | null
    /** BR-DE-6 / BR-DE-7: Telefon + E-Mail für BG-6 Seller Contact */
    email?: string | null
    phone?: string | null
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
    deliveryDate: invoice.deliveryDate
      ? (invoice.deliveryDate instanceof Date ? invoice.deliveryDate.toISOString() : invoice.deliveryDate)
      : undefined,
    currency: invoice.currency,
    buyerReference,
    supplier: {
      name: company.name,
      address: company.address || {},
      vatId: company.vatId || undefined,
      taxId: company.taxId || undefined,
      legalName: company.legalName || undefined,
      registerEntry: company.registerEntry || undefined,
      leitwegId: company.leitwegId || undefined,
      bankInfo: company.bankInfo || undefined,
      email: company.email || undefined,
      phone: company.phone || undefined,
    },
    customer: {
      name: invoice.customer?.name || '',
      address: invoice.customer?.address || {},
      vatId: invoice.customer?.vatId || undefined,
      email: (invoice.customer?.contact as any)?.email || undefined,
      leitwegId: customerAddress.leitwegId || undefined,
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
    // Tier 412
    euTransaction: invoice.euTransaction === true,
    reverseCharge: invoice.reverseCharge === true,
    hasDocumentDiscount:
      Number(invoice.discountPercent ?? 0) > 0 || Number(invoice.discountAmount ?? 0) > 0,
    taxBreakdown: invoiceTaxBreakdown({
      total: invoice.total,
      totalVat: invoice.totalVat,
      items: invoice.items,
    }).byRate,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
