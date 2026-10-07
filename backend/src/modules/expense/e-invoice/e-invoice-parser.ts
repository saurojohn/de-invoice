/**
 * Tier 573 — read an incoming e-invoice (EN 16931) into one neutral shape.
 *
 * Since 01.01.2025 every business in Germany has to be able to receive
 * e-invoices (§ 14 UStG, § 27 Abs. 38 UStG; BMF 15.10.2024). They arrive in
 * two syntaxes:
 *
 *   - UBL 2.1  — `Invoice` / `CreditNote` (XRechnung UBL, Peppol BIS)
 *   - UN/CEFACT CII — `CrossIndustryInvoice` (XRechnung CII, and the XML
 *     inside a ZUGFeRD / Factur-X PDF)
 *
 * Both carry the same business terms (BT-1 … BT-153); this maps them to
 * ParsedEInvoice. Nothing here touches the database.
 */
import { XmlElement, XmlReadError, at, child, children, readXml, textAt } from './xml-reader'

const NS_UBL_INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'
const NS_UBL_CREDITNOTE = 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2'
const NS_CII = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100'

export interface EInvoiceParty {
  /** BT-27 / BT-44, else the trading name */
  name: string | null
  tradingName: string | null
  vatId: string | null
  taxNumber: string | null
  street: string | null
  postalCode: string | null
  city: string | null
  country: string | null
  email: string | null
  phone: string | null
  contactName: string | null
}

export interface EInvoiceTaxGroup {
  /** BT-118: S, Z, E, AE, K, G, O, L, M */
  category: string
  /** BT-119 in percent (19, 7, 0) */
  rate: number
  /** BT-116 */
  taxableAmount: number
  /** BT-117 */
  taxAmount: number
  exemptionReason: string | null
}

export interface EInvoiceLine {
  id: string | null
  name: string | null
  description: string | null
  quantity: number | null
  unit: string | null
  unitPrice: number | null
  netAmount: number | null
  taxCategory: string | null
  taxRate: number | null
}

export interface ParsedEInvoice {
  syntax: 'ubl-invoice' | 'ubl-creditnote' | 'cii'
  /** BT-24 */
  customizationId: string | null
  profile: string
  /** false for ZUGFeRD MINIMUM / BASIC WL — booking aids, not invoices (BMF 15.10.2024 Rz. 30) */
  fullInvoice: boolean
  /** BT-3 */
  typeCode: string | null
  /** a document that reduces what is owed: its amounts are given positive here */
  creditNote: boolean
  number: string | null
  issueDate: string | null
  dueDate: string | null
  deliveryDate: string | null
  periodStart: string | null
  periodEnd: string | null
  currency: string | null
  buyerReference: string | null
  orderReference: string | null
  precedingInvoice: string | null
  notes: string[]
  seller: EInvoiceParty
  buyer: EInvoiceParty
  payment: {
    meansCode: string | null
    iban: string | null
    bic: string | null
    accountName: string | null
    remittance: string | null
    terms: string | null
    mandateId: string | null
  }
  totals: {
    lineNet: number | null
    allowances: number | null
    charges: number | null
    /** BT-109 */
    net: number | null
    /** BT-110 */
    tax: number | null
    /** BT-112 */
    gross: number | null
    prepaid: number | null
    rounding: number | null
    /** BT-115 */
    payable: number | null
  }
  taxGroups: EInvoiceTaxGroup[]
  lines: EInvoiceLine[]
  /** what keeps this from being booked */
  errors: string[]
  /** what the person importing should look at */
  warnings: string[]
}

export class EInvoiceFormatError extends Error {}

// ---- small readers -------------------------------------------------------

function num(s: string | null | undefined): number | null {
  if (s == null) return null
  const t = s.trim()
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) && Math.abs(n) < 1e12 ? n : null
}

function realDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  if (y < 1990 || y > 2100) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** UBL: xs:date (2026-03-01, optionally with a zone) */
function isoDate(s: string | null): string | null {
  const m = s && /^(\d{4})-(\d{2})-(\d{2})(?:Z|[+-]\d{2}:\d{2})?$/.exec(s.trim())
  return m ? realDate(+m[1], +m[2], +m[3]) : null
}

/** CII: udt:DateTimeString format 102 (20260301) */
function ciiDate(el: XmlElement | undefined): string | null {
  const s = textAt(el, 'DateTimeString') ?? (el?.name === 'DateTimeString' ? el.text : null)
  if (!s) return null
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s.trim())
  return m ? realDate(+m[1], +m[2], +m[3]) : isoDate(s)
}

const clip = (s: string | null, max: number) => (s ? s.replace(/\s+/g, ' ').trim().slice(0, max) || null : null)
const vatIdOf = (s: string | null) => (s ? s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || null : null)
const ibanOf = (s: string | null) => (s ? s.toUpperCase().replace(/\s+/g, '').slice(0, 34) || null : null)

function emptyParty(): EInvoiceParty {
  return { name: null, tradingName: null, vatId: null, taxNumber: null, street: null, postalCode: null, city: null, country: null, email: null, phone: null, contactName: null }
}

function profileOf(id: string | null, syntax: ParsedEInvoice['syntax']): { profile: string; fullInvoice: boolean } {
  const s = (id || '').toLowerCase()
  if (!s) return { profile: syntax === 'cii' ? 'CII (ohne Profilangabe)' : 'UBL (ohne Profilangabe)', fullInvoice: true }
  const xr = /xrechnung_(\d+)\.(\d+)/.exec(s)
  if (xr) return { profile: `XRechnung ${xr[1]}.${xr[2]}${s.includes('extension') ? ' (Extension)' : ''}`, fullInvoice: true }
  if (s.includes('peppol')) return { profile: 'Peppol BIS Billing 3.0', fullInvoice: true }
  if (/:minimum$/.test(s)) return { profile: 'ZUGFeRD / Factur-X MINIMUM', fullInvoice: false }
  if (/:basicwl$/.test(s)) return { profile: 'ZUGFeRD / Factur-X BASIC WL', fullInvoice: false }
  if (/:basic$/.test(s)) return { profile: 'ZUGFeRD / Factur-X BASIC', fullInvoice: true }
  if (/:extended$/.test(s)) return { profile: 'ZUGFeRD / Factur-X EXTENDED', fullInvoice: true }
  if (s === 'urn:cen.eu:en16931:2017') return { profile: syntax === 'cii' ? 'EN 16931 (ZUGFeRD / Factur-X COMFORT)' : 'EN 16931', fullInvoice: true }
  if (s.startsWith('urn:cen.eu:en16931:2017')) return { profile: 'EN 16931 (CIUS)', fullInvoice: true }
  return { profile: id!.slice(0, 80), fullInvoice: true }
}

// ---- UBL -------------------------------------------------------------------

function ublParty(party: XmlElement | undefined): EInvoiceParty {
  const p = emptyParty()
  if (!party) return p
  p.tradingName = clip(textAt(party, 'PartyName', 'Name'), 200)
  p.name = clip(textAt(party, 'PartyLegalEntity', 'RegistrationName'), 200) ?? p.tradingName
  const addr = child(party, 'PostalAddress')
  p.street = clip([textAt(addr, 'StreetName'), textAt(addr, 'AdditionalStreetName')].filter(Boolean).join(', ') || null, 200)
  p.postalCode = clip(textAt(addr, 'PostalZone'), 20)
  p.city = clip(textAt(addr, 'CityName'), 100)
  p.country = clip(textAt(addr, 'Country', 'IdentificationCode'), 2)?.toUpperCase() ?? null
  for (const ts of children(party, 'PartyTaxScheme')) {
    const scheme = (textAt(ts, 'TaxScheme', 'ID') || '').toUpperCase()
    const id = textAt(ts, 'CompanyID')
    if (!id) continue
    if (scheme === 'VAT') p.vatId = p.vatId ?? vatIdOf(id)
    else p.taxNumber = p.taxNumber ?? clip(id, 30)
  }
  const contact = child(party, 'Contact')
  p.contactName = clip(textAt(contact, 'Name'), 100)
  p.phone = clip(textAt(contact, 'Telephone'), 50)
  p.email = clip(textAt(contact, 'ElectronicMail'), 200)
  return p
}

function parseUbl(root: XmlElement, creditNoteDoc: boolean): ParsedEInvoice {
  const syntax: ParsedEInvoice['syntax'] = creditNoteDoc ? 'ubl-creditnote' : 'ubl-invoice'
  const customizationId = textAt(root, 'CustomizationID')
  const typeCode = textAt(root, creditNoteDoc ? 'CreditNoteTypeCode' : 'InvoiceTypeCode')
  const means = child(root, 'PaymentMeans')
  const total = child(root, 'LegalMonetaryTotal')
  const currency = textAt(root, 'DocumentCurrencyCode')
  // BT-110 is the TaxTotal in the document currency; a second TaxTotal (BT-111)
  // may give the tax in the accounting currency and has no subtotals.
  const taxTotals = children(root, 'TaxTotal')
  const mainTax = taxTotals.find((t) => children(t, 'TaxSubtotal').length > 0) ?? taxTotals[0]
  const taxGroups: EInvoiceTaxGroup[] = children(mainTax, 'TaxSubtotal').map((st) => ({
    category: (textAt(st, 'TaxCategory', 'ID') || '').toUpperCase(),
    rate: num(textAt(st, 'TaxCategory', 'Percent')) ?? 0,
    taxableAmount: num(textAt(st, 'TaxableAmount')) ?? NaN,
    taxAmount: num(textAt(st, 'TaxAmount')) ?? NaN,
    exemptionReason: clip(textAt(st, 'TaxCategory', 'TaxExemptionReason'), 300),
  }))
  const lines: EInvoiceLine[] = children(root, creditNoteDoc ? 'CreditNoteLine' : 'InvoiceLine').map((l) => {
    const qty = child(l, creditNoteDoc ? 'CreditedQuantity' : 'InvoicedQuantity')
    const item = child(l, 'Item')
    return {
      id: clip(textAt(l, 'ID'), 30),
      name: clip(textAt(item, 'Name'), 300),
      description: clip(textAt(item, 'Description'), 1000),
      quantity: num(qty?.text),
      unit: clip(qty?.attrs.unitCode ?? null, 10),
      unitPrice: num(textAt(l, 'Price', 'PriceAmount')),
      netAmount: num(textAt(l, 'LineExtensionAmount')),
      taxCategory: clip(textAt(item, 'ClassifiedTaxCategory', 'ID'), 3)?.toUpperCase() ?? null,
      taxRate: num(textAt(item, 'ClassifiedTaxCategory', 'Percent')),
    }
  })
  return finish({
    syntax,
    customizationId,
    ...profileOf(customizationId, syntax),
    typeCode,
    creditNote: creditNoteDoc,
    number: clip(textAt(root, 'ID'), 50),
    issueDate: isoDate(textAt(root, 'IssueDate')),
    dueDate: isoDate(textAt(root, 'DueDate')) ?? isoDate(textAt(means, 'PaymentDueDate')),
    deliveryDate: isoDate(textAt(root, 'Delivery', 'ActualDeliveryDate')),
    periodStart: isoDate(textAt(root, 'InvoicePeriod', 'StartDate')),
    periodEnd: isoDate(textAt(root, 'InvoicePeriod', 'EndDate')),
    currency: currency ? currency.toUpperCase().slice(0, 3) : null,
    buyerReference: clip(textAt(root, 'BuyerReference'), 100),
    orderReference: clip(textAt(root, 'OrderReference', 'ID'), 100),
    precedingInvoice: clip(textAt(root, 'BillingReference', 'InvoiceDocumentReference', 'ID'), 50),
    notes: children(root, 'Note').map((n) => clip(n.text, 1000)).filter((n): n is string => !!n),
    seller: ublParty(at(root, 'AccountingSupplierParty', 'Party')),
    buyer: ublParty(at(root, 'AccountingCustomerParty', 'Party')),
    payment: {
      meansCode: clip(textAt(means, 'PaymentMeansCode'), 5),
      iban: ibanOf(textAt(means, 'PayeeFinancialAccount', 'ID')),
      bic: clip(textAt(means, 'PayeeFinancialAccount', 'FinancialInstitutionBranch', 'ID'), 11),
      accountName: clip(textAt(means, 'PayeeFinancialAccount', 'Name'), 100),
      remittance: clip(textAt(means, 'PaymentID'), 140),
      terms: clip(textAt(root, 'PaymentTerms', 'Note'), 500),
      mandateId: clip(textAt(means, 'PaymentMandate', 'ID'), 50),
    },
    totals: {
      lineNet: num(textAt(total, 'LineExtensionAmount')),
      allowances: num(textAt(total, 'AllowanceTotalAmount')),
      charges: num(textAt(total, 'ChargeTotalAmount')),
      net: num(textAt(total, 'TaxExclusiveAmount')),
      tax: num(textAt(mainTax, 'TaxAmount')),
      gross: num(textAt(total, 'TaxInclusiveAmount')),
      prepaid: num(textAt(total, 'PrepaidAmount')),
      rounding: num(textAt(total, 'PayableRoundingAmount')),
      payable: num(textAt(total, 'PayableAmount')),
    },
    taxGroups,
    lines,
    errors: [],
    warnings: [],
  })
}

// ---- CII -------------------------------------------------------------------

function ciiParty(party: XmlElement | undefined): EInvoiceParty {
  const p = emptyParty()
  if (!party) return p
  p.name = clip(textAt(party, 'Name'), 200)
  p.tradingName = clip(textAt(party, 'SpecifiedLegalOrganization', 'TradingBusinessName'), 200)
  if (!p.name) p.name = p.tradingName
  const addr = child(party, 'PostalTradeAddress')
  p.street = clip([textAt(addr, 'LineOne'), textAt(addr, 'LineTwo')].filter(Boolean).join(', ') || null, 200)
  p.postalCode = clip(textAt(addr, 'PostcodeCode'), 20)
  p.city = clip(textAt(addr, 'CityName'), 100)
  p.country = clip(textAt(addr, 'CountryID'), 2)?.toUpperCase() ?? null
  for (const reg of children(party, 'SpecifiedTaxRegistration')) {
    const id = child(reg, 'ID')
    if (!id?.text) continue
    if ((id.attrs.schemeID || '').toUpperCase() === 'VA') p.vatId = p.vatId ?? vatIdOf(id.text)
    else p.taxNumber = p.taxNumber ?? clip(id.text, 30)
  }
  const contact = child(party, 'DefinedTradeContact')
  p.contactName = clip(textAt(contact, 'PersonName') ?? textAt(contact, 'DepartmentName'), 100)
  p.phone = clip(textAt(contact, 'TelephoneUniversalCommunication', 'CompleteNumber'), 50)
  p.email = clip(textAt(contact, 'EmailURIUniversalCommunication', 'URIID'), 200)
  return p
}

function parseCii(root: XmlElement): ParsedEInvoice {
  const customizationId = textAt(root, 'ExchangedDocumentContext', 'GuidelineSpecifiedDocumentContextParameter', 'ID')
  const doc = child(root, 'ExchangedDocument')
  const tx = child(root, 'SupplyChainTradeTransaction')
  const agreement = child(tx, 'ApplicableHeaderTradeAgreement')
  const delivery = child(tx, 'ApplicableHeaderTradeDelivery')
  const settlement = child(tx, 'ApplicableHeaderTradeSettlement')
  const sum = child(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation')
  const means = child(settlement, 'SpecifiedTradeSettlementPaymentMeans')
  const terms = child(settlement, 'SpecifiedTradePaymentTerms')
  const typeCode = textAt(doc, 'TypeCode')
  const currency = textAt(settlement, 'InvoiceCurrencyCode')
  // BT-110: the TaxTotalAmount in the invoice currency (a second one may be BT-111)
  const taxTotals = children(sum, 'TaxTotalAmount')
  const taxTotal = taxTotals.find((t) => !t.attrs.currencyID || t.attrs.currencyID.toUpperCase() === (currency || '').toUpperCase()) ?? taxTotals[0]
  const taxGroups: EInvoiceTaxGroup[] = children(settlement, 'ApplicableTradeTax').map((t) => ({
    category: (textAt(t, 'CategoryCode') || '').toUpperCase(),
    rate: num(textAt(t, 'RateApplicablePercent')) ?? 0,
    taxableAmount: num(textAt(t, 'BasisAmount')) ?? NaN,
    taxAmount: num(textAt(t, 'CalculatedAmount')) ?? NaN,
    exemptionReason: clip(textAt(t, 'ExemptionReason'), 300),
  }))
  const lines: EInvoiceLine[] = children(tx, 'IncludedSupplyChainTradeLineItem').map((l) => {
    const qty = at(l, 'SpecifiedLineTradeDelivery', 'BilledQuantity')
    const lineTax = at(l, 'SpecifiedLineTradeSettlement', 'ApplicableTradeTax')
    return {
      id: clip(textAt(l, 'AssociatedDocumentLineDocument', 'LineID'), 30),
      name: clip(textAt(l, 'SpecifiedTradeProduct', 'Name'), 300),
      description: clip(textAt(l, 'SpecifiedTradeProduct', 'Description'), 1000),
      quantity: num(qty?.text),
      unit: clip(qty?.attrs.unitCode ?? null, 10),
      unitPrice: num(textAt(l, 'SpecifiedLineTradeAgreement', 'NetPriceProductTradePrice', 'ChargeAmount')),
      netAmount: num(textAt(l, 'SpecifiedLineTradeSettlement', 'SpecifiedTradeSettlementLineMonetarySummation', 'LineTotalAmount')),
      taxCategory: clip(textAt(lineTax, 'CategoryCode'), 3)?.toUpperCase() ?? null,
      taxRate: num(textAt(lineTax, 'RateApplicablePercent')),
    }
  })
  return finish({
    syntax: 'cii',
    customizationId,
    ...profileOf(customizationId, 'cii'),
    typeCode,
    creditNote: false,
    number: clip(textAt(doc, 'ID'), 50),
    issueDate: ciiDate(child(doc, 'IssueDateTime')),
    dueDate: ciiDate(child(terms, 'DueDateDateTime')),
    deliveryDate: ciiDate(at(delivery, 'ActualDeliverySupplyChainEvent', 'OccurrenceDateTime')),
    periodStart: ciiDate(at(settlement, 'BillingSpecifiedPeriod', 'StartDateTime')),
    periodEnd: ciiDate(at(settlement, 'BillingSpecifiedPeriod', 'EndDateTime')),
    currency: currency ? currency.toUpperCase().slice(0, 3) : null,
    buyerReference: clip(textAt(agreement, 'BuyerReference'), 100),
    orderReference: clip(textAt(agreement, 'BuyerOrderReferencedDocument', 'IssuerAssignedID'), 100),
    precedingInvoice: clip(textAt(settlement, 'InvoiceReferencedDocument', 'IssuerAssignedID'), 50),
    notes: children(doc, 'IncludedNote').map((n) => clip(textAt(n, 'Content'), 1000)).filter((n): n is string => !!n),
    seller: ciiParty(child(agreement, 'SellerTradeParty')),
    buyer: ciiParty(child(agreement, 'BuyerTradeParty')),
    payment: {
      meansCode: clip(textAt(means, 'TypeCode'), 5),
      iban: ibanOf(textAt(means, 'PayeePartyCreditorFinancialAccount', 'IBANID')),
      bic: clip(textAt(means, 'PayeeSpecifiedCreditorFinancialInstitution', 'BICID'), 11),
      accountName: clip(textAt(means, 'PayeePartyCreditorFinancialAccount', 'AccountName'), 100),
      remittance: clip(textAt(settlement, 'PaymentReference'), 140),
      terms: clip(textAt(terms, 'Description'), 500),
      mandateId: clip(textAt(terms, 'DirectDebitMandateID'), 50),
    },
    totals: {
      lineNet: num(textAt(sum, 'LineTotalAmount')),
      allowances: num(textAt(sum, 'AllowanceTotalAmount')),
      charges: num(textAt(sum, 'ChargeTotalAmount')),
      net: num(textAt(sum, 'TaxBasisTotalAmount')),
      tax: num(taxTotal?.text),
      gross: num(textAt(sum, 'GrandTotalAmount')),
      prepaid: num(textAt(sum, 'TotalPrepaidAmount')),
      rounding: num(textAt(sum, 'RoundingAmount')),
      payable: num(textAt(sum, 'DuePayableAmount')),
    },
    taxGroups,
    lines,
    errors: [],
    warnings: [],
  })
}

// ---- what both have in common ---------------------------------------------

const cents = (n: number) => Math.round(n * 100)
const eur = (n: number) => n.toFixed(2).replace('.', ',')
const TAX_CATEGORIES = new Set(['S', 'Z', 'E', 'AE', 'K', 'G', 'O', 'L', 'M'])

/** Sign, sums and the things a person should see before booking it. */
function finish(inv: ParsedEInvoice): ParsedEInvoice {
  const { errors, warnings, totals } = inv

  for (const g of inv.taxGroups) {
    if (!Number.isFinite(g.taxableAmount) || !Number.isFinite(g.taxAmount)) {
      errors.push('Eine Umsatzsteuer-Zeile hat keinen gültigen Betrag (BT-116 / BT-117).')
      g.taxableAmount = Number.isFinite(g.taxableAmount) ? g.taxableAmount : 0
      g.taxAmount = Number.isFinite(g.taxAmount) ? g.taxAmount : 0
    }
  }

  // A credit note is a CreditNote document, type 381, or an invoice whose
  // totals are negative. Its amounts are given positive from here on.
  const negative = (totals.gross ?? totals.net ?? 0) < 0
  if (inv.typeCode === '381' || negative) inv.creditNote = true
  if (negative) {
    const flip = (n: number | null) => (n == null ? n : n === 0 ? 0 : -n)
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = flip(totals[k])
    for (const g of inv.taxGroups) {
      g.taxableAmount = flip(g.taxableAmount)!
      g.taxAmount = flip(g.taxAmount)!
    }
    for (const l of inv.lines) l.netAmount = flip(l.netAmount)
  }

  if (!inv.number) errors.push('Die Rechnungsnummer (BT-1) fehlt.')
  if (!inv.issueDate) errors.push('Das Rechnungsdatum (BT-2) fehlt oder ist kein Datum.')
  if (!inv.seller.name) errors.push('Der Name des Rechnungsstellers (BT-27) fehlt.')
  if (totals.gross == null) errors.push('Der Bruttobetrag (BT-112) fehlt.')
  if (totals.net == null) errors.push('Der Nettobetrag (BT-109) fehlt.')

  // MINIMUM carries no VAT breakdown: one group from the totals, when they
  // fit a whole percentage.
  if (inv.taxGroups.length === 0 && totals.net != null && totals.gross != null) {
    const tax = totals.tax ?? totals.gross - totals.net
    const rate = totals.net !== 0 ? (tax / totals.net) * 100 : 0
    const whole = Math.round(rate)
    if (totals.net !== 0 && Math.abs(rate - whole) < 0.2) {
      inv.taxGroups.push({ category: whole === 0 ? 'O' : 'S', rate: whole, taxableAmount: totals.net, taxAmount: tax, exemptionReason: null })
      warnings.push(`Die Datei nennt keine Aufschlüsselung der Umsatzsteuer; ${whole} % wurden aus den Summen abgeleitet.`)
    } else {
      errors.push('Die Datei nennt keine Aufschlüsselung der Umsatzsteuer (BG-23).')
    }
  }
  for (const g of inv.taxGroups) {
    if (!TAX_CATEGORIES.has(g.category)) errors.push(`Unbekannte Umsatzsteuer-Kategorie „${g.category.slice(0, 10)}“ (BT-118).`)
    if (g.rate < 0 || g.rate > 100) errors.push(`Der Steuersatz ${g.rate} % (BT-119) ist ungültig.`)
    if (g.category !== 'S' && g.category !== 'L' && g.category !== 'M' && cents(g.taxAmount) !== 0) {
      errors.push(`Die Kategorie ${g.category} weist ${eur(g.taxAmount)} Umsatzsteuer aus; sie ist steuerfrei oder nicht steuerbar.`)
    }
  }

  // The sums must agree with each other (BR-CO-13 … BR-CO-15), to the cent
  // per VAT line.
  if (inv.taxGroups.length && totals.net != null && totals.gross != null) {
    const slack = Math.max(1, inv.taxGroups.length)
    const sumNet = inv.taxGroups.reduce((s, g) => s + cents(g.taxableAmount), 0)
    const sumTax = inv.taxGroups.reduce((s, g) => s + cents(g.taxAmount), 0)
    if (Math.abs(sumNet - cents(totals.net)) > slack) {
      errors.push(`Die Bemessungsgrundlagen der Steuerzeilen (${eur(sumNet / 100)}) ergeben nicht den Nettobetrag (${eur(totals.net)}).`)
    }
    if (totals.tax != null && Math.abs(sumTax - cents(totals.tax)) > slack) {
      errors.push(`Die Steuerbeträge der Steuerzeilen (${eur(sumTax / 100)}) ergeben nicht die Umsatzsteuer der Rechnung (${eur(totals.tax)}).`)
    }
    if (Math.abs(cents(totals.net) + sumTax - cents(totals.gross)) > slack) {
      errors.push(`Netto (${eur(totals.net)}) und Umsatzsteuer (${eur(sumTax / 100)}) ergeben nicht den Bruttobetrag (${eur(totals.gross)}).`)
    }
  }

  if (!inv.fullInvoice) {
    warnings.push(`Das Profil ${inv.profile} ist eine Buchungshilfe und keine E-Rechnung im Sinne des § 14 UStG; maßgeblich ist das Bild der PDF-Datei.`)
  }
  if (inv.typeCode === '389') warnings.push('Gutschrift im Abrechnungsverfahren (Typ 389, § 14 Abs. 2 Satz 5 UStG).')
  if (inv.typeCode === '384') warnings.push('Rechnungskorrektur (Typ 384)' + (inv.precedingInvoice ? ` zu ${inv.precedingInvoice}.` : '.'))
  if (inv.typeCode === '386') warnings.push('Anzahlungsrechnung (Typ 386).')
  if (inv.creditNote) warnings.push('Das ist eine Gutschrift / Rechnungskorrektur des Lieferanten: sie mindert Aufwand und Vorsteuer.')
  if (inv.taxGroups.some((g) => g.category === 'AE')) {
    warnings.push('Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG): die Steuer schulden Sie selbst. Sie wird mit 19 % angenommen; gilt 7 %, den Satz in der Ausgabe ändern.')
  }
  if (inv.taxGroups.some((g) => g.category === 'K')) {
    warnings.push('Innergemeinschaftlicher Erwerb (§ 1a UStG): die Erwerbsteuer schulden Sie selbst. Sie wird mit 19 % angenommen; gilt 7 %, den Satz in der Ausgabe ändern.')
  }
  if (totals.payable != null && totals.gross != null && cents(totals.payable) === 0 && cents(totals.gross) !== 0) {
    warnings.push('Laut Rechnung ist nichts mehr zu zahlen (Zahlbetrag 0,00) — sie ist bereits bezahlt.')
  } else if (totals.prepaid != null && cents(totals.prepaid) !== 0) {
    warnings.push(`Laut Rechnung sind ${eur(totals.prepaid)} bereits gezahlt; offen sind ${eur(totals.payable ?? 0)}.`)
  }
  if (inv.payment.meansCode === '59' || inv.payment.mandateId) {
    warnings.push('Der Betrag wird per SEPA-Lastschrift eingezogen — nicht selbst überweisen.')
  }
  return inv
}

/** Read an e-invoice XML document. Throws EInvoiceFormatError when it is none. */
export function parseEInvoiceXml(xml: string): ParsedEInvoice {
  let root: XmlElement
  try {
    root = readXml(xml)
  } catch (e) {
    if (e instanceof XmlReadError) throw new EInvoiceFormatError(e.message)
    throw e
  }
  if (root.ns === NS_UBL_INVOICE && root.name === 'Invoice') return parseUbl(root, false)
  if (root.ns === NS_UBL_CREDITNOTE && root.name === 'CreditNote') return parseUbl(root, true)
  if (root.ns === NS_CII && root.name === 'CrossIndustryInvoice') return parseCii(root)
  if (root.name === 'CrossIndustryDocument') {
    throw new EInvoiceFormatError('Das ist ZUGFeRD 1.0. Dieses alte Format ist keine E-Rechnung nach EN 16931 und wird nicht eingelesen.')
  }
  throw new EInvoiceFormatError(
    `Die XML-Datei ist keine E-Rechnung (erwartet: UBL Invoice / CreditNote oder UN/CEFACT CrossIndustryInvoice; gefunden: <${root.name.slice(0, 60)}>).`,
  )
}
