import {
  computeXRechnungTotals,
  EXEMPTION,
  formatCents,
  generateXRechnung,
  mapUnitToUNECE,
  normalizeCountryCode,
  transformToXRechnungData,
  vatEasScheme,
  XRechnungData,
} from './xrechnung.service';
import { embedFacturX } from './zugferd-embed';
import { generateInvoicePDF } from './invoice-pdf.service';

/**
 * ZUGFeRD Service
 * Generates electronic invoices in ZUGFeRD 1.0 / 2.0 format
 * ZUGFeRD = PDF/A-3 with embedded XML (Factur-X standard)
 *
 * Pipeline:
 *   1. PDFKit draws a visually-pleasant PDF (same layout as
 *      invoice-pdf.service.ts)
 *   2. The ZUGFeRD 2.x XML (CrossIndustryInvoice) is generated
 *      by generateZUGFeRDXml()
 *   3. zugferd-embed.ts loads the PDF with pdf-lib, attaches
 *      the XML as `factur-x.xml` with AFRelationship=Source+Data,
 *      and writes the Factur-X XMP metadata
 *   4. The result is a single PDF that humans can read AND
 *      ERP systems (Lexware, SevDesk, Datev, etc.) can parse
 */

export interface ZUGFeRDOptions {
  version?: '1.0' | '2.0' | '2.1';
  conformanceLevel?: 'BASIC' | 'EN16931' | 'EXTENDED';
  /**
   * Tier 7.5 visual config (fontFamily / primaryColor /
   * layoutDensity / footerText / paymentTermsText).
   * Polish #10: forwarded to generateInvoicePDF so
   * ZUGFeRD output honours the company's InvoiceTemplate
   * (previously always used Helvetica + black).
   */
  templateConfig?: import('./invoice-pdf.service').InvoiceRenderConfig;
}

/**
 * Generate ZUGFeRD PDF with embedded XML data
 * Uses PDF/A-3 format for archival compliance
 */
export async function generateZUGFeRD(
  invoice: {
    invoiceNumber: string;
    issueDate: Date | string;
    dueDate?: Date | string | null;
    currency: string;
    subtotal: any;
    totalVat: any;
    total: any;
    notes?: string | null;
    customer: {
      name: string;
      vatId?: string | null;
      address: any;
      contact?: any;
    };
    items: {
      description: string;
      quantity: any;
      unit?: string | null;
      unitPrice: any;
      vatRate: any;
      netAmount: any;
      vatAmount: any;
      grossAmount: any;
    }[];
  },
  company: {
    name: string;
    legalName?: string;
    vatId?: string | null;
    taxId?: string | null;
    address: any;
    email?: string;
    phone?: string;
    fax?: string;
    website?: string;
    registerEntry?: string;
    managingDirector?: string;
    otherInfo?: string;
    bankInfo?: any;
    logoPath?: string | null;
  },
  options: ZUGFeRDOptions = {}
): Promise<Buffer> {
  const {
    version = '2.1',
    conformanceLevel = 'EN16931'
  } = options;

  // Transform to XRechnung format first (ZUGFeRD uses same data structure)
  const xrechnungData = transformToXRechnungData(invoice, company);

  // Generate XRechnung XML
  //
  // Tier 356: the result is never used -- the ZUGFeRD PDF embeds
  // `zugferdXml` below, not this. The call is kept (and the binding
  // underscored) rather than deleted because generateXRechnung also
  // walks the whole invoice and would throw on malformed data, so it
  // currently doubles as a validation pass. If that is not intended,
  // deleting the call is a free saving -- but that is a behaviour
  // decision, not a lint cleanup.
  const _xmlContent = generateXRechnung(xrechnungData);

  // Generate ZUGFeRD XML (Factur-X profile)
  const zugferdXml = generateZUGFeRDXml(xrechnungData, version, conformanceLevel);

  // Create the visual PDF — humans read this part.
  // Reuse the canonical invoice-pdf generator instead of
  // maintaining a duplicate PDFKit layout (which drifted out
  // of sync with the invoice PDF in earlier revisions — see
  // git history).
  //
  // The footer's "ZUGFeRD konform" line is rendered on top of
  // the standard PDF via the ZUGFeRD layer below.
  const visualPdf = await generateInvoicePDF(invoice as any, company as any, 'standard', options.templateConfig);

  // Embed the XML into the PDF — machines read this part.
  // This is the step that turns a "PDF with a ZUGFeRD footer"
  // into a real ZUGFeRD / Factur-X document.
  return embedFacturX(visualPdf, zugferdXml, version, conformanceLevel);
}

/**
 * Tier 414 — the CII D16B CrossIndustryInvoice embedded in the PDF
 * (Factur-X / ZUGFeRD 2.x, EN 16931 profile).
 *
 * The previous generator wrote elements that do not exist in CII —
 * `SupplierTradeParty`, `DefinedTradeAddress`, `StreetName`,
 * `ExchangedDocument/IssueDate` with "01.09.2026" — in the wrong order (parties
 * straight under the transaction, lines last), so the XML failed the CII
 * schema before a single business rule was checked. Its amounts had the
 * pre-Tier 412 defects too: the tax breakdown came from the undiscounted lines
 * (basis 1000, tax 190 next to a total tax of 171) and every rate was category
 * S, a 0 % igL invoice included.
 *
 * The amounts, tax categories and discount allowances now come from
 * computeXRechnungTotals — the same computation the XRechnung uses — and the
 * element order follows the CII D16B schema. Validated with KoSIT against the
 * CII D16B XSD and the CEN EN 16931 CII schematron 1.3.16 (scenarios.xml).
 */
export function generateZUGFeRDXml(
  data: XRechnungData,
  _version: string,
  _conformanceLevel: string
): string {
  const t = computeXRechnungTotals(data);
  const cur = escapeXml(data.currency);

  const lineItems = data.items.map((item, index) => `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${index + 1}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${escapeXml(item.description.split('\n')[0])}</ram:Name>
        ${item.description.includes('\n') ? `<ram:Description>${escapeXml(item.description)}</ram:Description>` : ''}
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${formatDecimal4(item.unitPrice)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${mapUnitToUNECE(item.unit)}">${formatDecimal4(item.quantity)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${t.categoryOf(item.vatRate)}</ram:CategoryCode>
          <ram:RateApplicablePercent>${formatPercent(item.vatRate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${formatCents(t.lineNets[index])}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`).join('');

  const taxBreakdown = t.subtotals.map((v) => {
    const ex = v.category === 'S' ? undefined : EXEMPTION[v.category];
    return `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${formatCents(v.tax)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        ${ex ? `<ram:ExemptionReason>${escapeXml(ex.text)}</ram:ExemptionReason>` : ''}
        <ram:BasisAmount>${formatCents(v.taxable)}</ram:BasisAmount>
        <ram:CategoryCode>${v.category}</ram:CategoryCode>
        ${ex?.code ? `<ram:ExemptionReasonCode>${ex.code}</ram:ExemptionReasonCode>` : ''}
        <ram:RateApplicablePercent>${formatPercent(v.rate)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`;
  }).join('');

  // One document allowance per VAT category (reason code 95 = discount).
  const allowances = t.allowances.map((a) => `
      <ram:SpecifiedTradeAllowanceCharge>
        <ram:ChargeIndicator>
          <udt:Indicator>false</udt:Indicator>
        </ram:ChargeIndicator>
        <ram:ActualAmount>${formatCents(a.amount)}</ram:ActualAmount>
        <ram:ReasonCode>95</ram:ReasonCode>
        <ram:Reason>Rabatt</ram:Reason>
        <ram:CategoryTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${a.category}</ram:CategoryCode>
          <ram:RateApplicablePercent>${formatPercent(a.rate)}</ram:RateApplicablePercent>
        </ram:CategoryTradeTax>
      </ram:SpecifiedTradeAllowanceCharge>`).join('');

  // Skonto is a payment term, written in the XRechnung #SKONTO# convention
  // (as in the UBL, Tier 412).
  let terms = data.paymentTermsNote;
  if (!terms && data.skonto) {
    terms = `Zahlbar innerhalb von ${data.skonto.days ?? 14} Tagen mit ${(data.skonto.percent * 100).toFixed(2)}% Skonto`;
  }
  if (data.skonto) {
    terms = `${terms}\n#SKONTO#TAGE=${data.skonto.days ?? 14}#PROZENT=${(data.skonto.percent * 100).toFixed(2)}#\n`;
  }
  const paymentTerms = terms || data.dueDate ? `
      <ram:SpecifiedTradePaymentTerms>
        ${terms ? `<ram:Description>${escapeXml(terms)}</ram:Description>` : ''}
        ${data.dueDate ? `<ram:DueDateDateTime>
          <udt:DateTimeString format="102">${formatDate102(data.dueDate)}</udt:DateTimeString>
        </ram:DueDateDateTime>` : ''}
      </ram:SpecifiedTradePaymentTerms>` : '';

  const iban = data.supplier.bankInfo?.iban?.replace(/\s+/g, '');
  const paymentMeans = iban ? `
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>${escapeXml(iban)}</ram:IBANID>
          ${data.supplier.bankInfo?.bankName ? `<ram:AccountName>${escapeXml(data.supplier.name)}</ram:AccountName>` : ''}
        </ram:PayeePartyCreditorFinancialAccount>
        ${data.supplier.bankInfo?.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution>
          <ram:BICID>${escapeXml(data.supplier.bankInfo.bic)}</ram:BICID>
        </ram:PayeeSpecifiedCreditorFinancialInstitution>` : ''}
      </ram:SpecifiedTradeSettlementPaymentMeans>` : '';

  // BR-IC-12: an intra-community supply names the deliver-to country.
  const shipTo = t.categories.includes('K') ? `
      <ram:ShipToTradeParty>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${escapeXml(data.customer.address.postalCode || '')}</ram:PostcodeCode>
          <ram:LineOne>${escapeXml(data.customer.address.street || '')}</ram:LineOne>
          <ram:CityName>${escapeXml(data.customer.address.city || '')}</ram:CityName>
          <ram:CountryID>${escapeXml(normalizeCountryCode(data.customer.address.country))}</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:ShipToTradeParty>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
                          xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
                          xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"
                          xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${escapeXml(data.invoiceNumber)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${formatDate102(data.issueDate)}</udt:DateTimeString>
    </ram:IssueDateTime>
    ${data.notes ? `<ram:IncludedNote>
      <ram:Content>${escapeXml(data.notes)}</ram:Content>
    </ram:IncludedNote>` : ''}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${lineItems}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>${escapeXml(data.buyerReference)}</ram:BuyerReference>
      ${generateSellerParty(data.supplier)}
      ${generateBuyerParty(data.customer)}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>${shipTo}
      <!-- BT-72 Leistungsdatum; the issue date when none was recorded, as the
           UBL's invoice period does. BR-IC-11 requires it for igL. -->
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime>
          <udt:DateTimeString format="102">${formatDate102(data.deliveryDate ?? data.issueDate)}</udt:DateTimeString>
        </ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${cur}</ram:InvoiceCurrencyCode>${paymentMeans}${taxBreakdown}${allowances}${paymentTerms}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${formatCents(t.lineExtension)}</ram:LineTotalAmount>
        ${t.allowanceTotal !== 0 ? `<ram:AllowanceTotalAmount>${formatCents(t.allowanceTotal)}</ram:AllowanceTotalAmount>` : ''}
        <ram:TaxBasisTotalAmount>${formatCents(t.taxExclusive)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${cur}">${formatCents(t.taxTotal)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${formatCents(t.taxInclusive)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${formatCents(t.payable)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

/** PostalTradeAddress in D16B order: PostcodeCode, LineOne, CityName, CountryID. */
function postalAddress(a: { street?: string; postalCode?: string; city?: string; country?: string }): string {
  return `<ram:PostalTradeAddress>
          <ram:PostcodeCode>${escapeXml(a.postalCode || '')}</ram:PostcodeCode>
          <ram:LineOne>${escapeXml(a.street || '')}</ram:LineOne>
          <ram:CityName>${escapeXml(a.city || '')}</ram:CityName>
          <ram:CountryID>${escapeXml(normalizeCountryCode(a.country))}</ram:CountryID>
        </ram:PostalTradeAddress>`;
}

/**
 * Seller (BG-4). TradePartyType order: ID, Name, SpecifiedLegalOrganization,
 * DefinedTradeContact, PostalTradeAddress, URIUniversalCommunication,
 * SpecifiedTaxRegistration. Identifiers as in the UBL (Tier 412): register
 * entry as BT-30, a Steuernummer as BT-32 (FC) and — with no VAT id and no
 * register entry — also as BT-29 (BR-CO-26).
 */
function generateSellerParty(s: XRechnungData['supplier']): string {
  const endpoint = s.email
    ? { id: s.email, scheme: 'EM' }
    : s.vatId && vatEasScheme(s.vatId)
      ? { id: s.vatId, scheme: vatEasScheme(s.vatId)! }
      : undefined;
  return `<ram:SellerTradeParty>
        ${!s.vatId && !s.registerEntry && s.taxId ? `<ram:ID>${escapeXml(s.taxId)}</ram:ID>` : ''}
        <ram:Name>${escapeXml(s.legalName || s.name)}</ram:Name>
        ${s.registerEntry ? `<ram:SpecifiedLegalOrganization>
          <ram:ID>${escapeXml(s.registerEntry)}</ram:ID>
          ${s.legalName && s.legalName !== s.name ? `<ram:TradingBusinessName>${escapeXml(s.name)}</ram:TradingBusinessName>` : ''}
        </ram:SpecifiedLegalOrganization>` : ''}
        ${s.phone || s.email ? `<ram:DefinedTradeContact>
          <ram:PersonName>${escapeXml(s.legalName || s.name)}</ram:PersonName>
          ${s.phone ? `<ram:TelephoneUniversalCommunication>
            <ram:CompleteNumber>${escapeXml(s.phone)}</ram:CompleteNumber>
          </ram:TelephoneUniversalCommunication>` : ''}
          ${s.email ? `<ram:EmailURIUniversalCommunication>
            <ram:URIID>${escapeXml(s.email)}</ram:URIID>
          </ram:EmailURIUniversalCommunication>` : ''}
        </ram:DefinedTradeContact>` : ''}
        ${postalAddress(s.address)}
        ${endpoint ? `<ram:URIUniversalCommunication>
          <ram:URIID schemeID="${endpoint.scheme}">${escapeXml(endpoint.id)}</ram:URIID>
        </ram:URIUniversalCommunication>` : ''}
        ${s.vatId ? `<ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${escapeXml(s.vatId)}</ram:ID>
        </ram:SpecifiedTaxRegistration>` : ''}
        ${s.taxId ? `<ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="FC">${escapeXml(s.taxId)}</ram:ID>
        </ram:SpecifiedTaxRegistration>` : ''}
      </ram:SellerTradeParty>`;
}

/** Buyer (BG-7), same element order; electronic address as in the UBL. */
function generateBuyerParty(c: XRechnungData['customer']): string {
  const endpoint = c.leitwegId
    ? { id: c.leitwegId, scheme: '0204' }
    : c.email
      ? { id: c.email, scheme: 'EM' }
      : c.vatId && vatEasScheme(c.vatId)
        ? { id: c.vatId, scheme: vatEasScheme(c.vatId)! }
        : undefined;
  return `<ram:BuyerTradeParty>
        <ram:Name>${escapeXml(c.name)}</ram:Name>
        ${postalAddress(c.address)}
        ${endpoint ? `<ram:URIUniversalCommunication>
          <ram:URIID schemeID="${endpoint.scheme}">${escapeXml(endpoint.id)}</ram:URIID>
        </ram:URIUniversalCommunication>` : ''}
        ${c.vatId ? `<ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${escapeXml(c.vatId)}</ram:ID>
        </ram:SpecifiedTaxRegistration>` : ''}
      </ram:BuyerTradeParty>`;
}

/** CII date format 102: YYYYMMDD. */
function formatDate102(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function formatDecimal4(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

function formatPercent(rate: number): string {
  return (rate * 100).toFixed(2);
}




function escapeXml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

