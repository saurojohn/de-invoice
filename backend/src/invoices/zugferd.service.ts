import { generateXRechnung, transformToXRechnungData, XRechnungData } from './xrechnung.service';
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

function generateZUGFeRDXml(
  data: XRechnungData,
  version: string,
  _conformanceLevel: string
): string {
  const invoiceDate = formatDate(data.issueDate);
  const dueDate = data.dueDate ? formatDate(data.dueDate) : null;

  // Build seller/buyer trade parties
  const sellerParty = generateTradeParty(data.supplier, 'Supplier');
  const buyerParty = generateTradeParty(data.customer, 'Buyer');

  // Build line items
  const lineItems = data.items.map((item, index) => `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${index + 1}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${escapeXml(item.description.split('\n')[0])}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${formatDecimal(item.unitPrice)}</ram:ChargeAmount>
          <ram:BasisQuantity unitCode="C62">${formatDecimal(item.quantity)}</ram:BasisQuantity>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="C62">${formatDecimal(item.quantity)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${item.vatRate > 0 ? 'S' : 'E'}</ram:CategoryCode>
          <ram:RateApplicablePercent>${formatPercent(item.vatRate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount currencyID="${data.currency}">${formatDecimal(item.netAmount)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`).join('');

  // Build VAT breakdown
  const vatByRate = groupVatByRate(data.items);
  const vatBreakdown = vatByRate.map(vat => `
    <ram:ApplicableTradeTax>
      <ram:CalculatedAmount currencyID="${data.currency}">${formatDecimal(vat.taxAmount)}</ram:CalculatedAmount>
      <ram:TypeCode>VAT</ram:TypeCode>
      <ram:ExemptionReason></ram:ExemptionReason>
      <ram:BasisAmount currencyID="${data.currency}">${formatDecimal(vat.taxableAmount)}</ram:BasisAmount>
      <ram:CategoryCode>S</ram:CategoryCode>
      <ram:RateApplicablePercent>${formatPercent(vat.rate)}</ram:RateApplicablePercent>
    </ram:ApplicableTradeTax>`).join('');

  // Build payment terms
  const paymentTerms = dueDate ? `
    <ram:SpecifiedTradePaymentTerms>
      <ram:Description>Zahlbar bis ${dueDate}</ram:Description>
    </ram:SpecifiedTradePaymentTerms>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
                          xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
                          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">

  <rsm:ExchangedDocumentContext>
    <ram:TestIndicator>${false}</ram:TestIndicator>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
      <ram:Name>Factur-X</ram:Name>
      <ram:Version>${version}</ram:Version>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>

  <rsm:ExchangedDocument>
    <ram:ID>${escapeXml(data.invoiceNumber)}</ram:ID>
    <ram:Name>RECHNUNG</ram:Name>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDate>${invoiceDate}</ram:IssueDate>
    ${dueDate ? `<ram:DueDate>${dueDate}</ram:DueDate>` : ''}
    <ram:IncludedNote>
      <ram:Content>Rechnungsdokument</ram:Content>
    </ram:IncludedNote>
  </rsm:ExchangedDocument>

  <rsm:SupplyChainTradeTransaction>
    ${sellerParty}
    ${buyerParty}
    ${paymentTerms}
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${escapeXml(data.currency)}</ram:InvoiceCurrencyCode>
      ${vatBreakdown}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount currencyID="${data.currency}">${formatDecimal(data.subtotal)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount currencyID="${data.currency}">${formatDecimal(data.subtotal)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${data.currency}">${formatDecimal(data.totalVat)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount currencyID="${data.currency}">${formatDecimal(data.total)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount currencyID="${data.currency}">${formatDecimal(data.total)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
    ${lineItems}
  </rsm:SupplyChainTradeTransaction>

</rsm:CrossIndustryInvoice>`;
}

function generateTradeParty(
  party: { name: string; address: any; vatId?: string; email?: string },
  type: 'Supplier' | 'Buyer'
): string {

  return `
    <ram:${type}TradeParty>
      <ram:Name>${escapeXml(party.name)}</ram:Name>
      ${party.vatId ? `<ram:SpecifiedTaxRegistration>
        <ram:ID schemeID="VA">${escapeXml(party.vatId)}</ram:ID>
      </ram:SpecifiedTaxRegistration>` : ''}
      <ram:DefinedTradeAddress>
        <ram:StreetName>${escapeXml(party.address?.street || '')}</ram:StreetName>
        <ram:CityName>${escapeXml(party.address?.city || '')}</ram:CityName>
        <ram:PostcodeCode>${escapeXml(party.address?.postalCode || '')}</ram:PostcodeCode>
        <ram:CountryID>${escapeXml(party.address?.country || 'DE')}</ram:CountryID>
      </ram:DefinedTradeAddress>
      ${party.email ? `<ram:DefinedTradeContact>
        <ram:EmailURIUniversalCommunication>
          <ram:URIID>${escapeXml(party.email)}</ram:URIID>
        </ram:EmailURIUniversalCommunication>
      </ram:DefinedTradeContact>` : ''}
    </ram:${type}TradeParty>`;
}


function groupVatByRate(items: XRechnungData['items']): { rate: number; taxableAmount: number; taxAmount: number }[] {
  const grouped: Map<number, { taxableAmount: number; taxAmount: number }> = new Map();

  for (const item of items) {
    const existing = grouped.get(item.vatRate);
    if (existing) {
      existing.taxableAmount += item.netAmount;
      existing.taxAmount += item.vatAmount;
    } else {
      grouped.set(item.vatRate, {
        taxableAmount: item.netAmount,
        taxAmount: item.vatAmount,
      });
    }
  }

  return Array.from(grouped.entries()).map(([rate, values]) => ({
    rate,
    taxableAmount: values.taxableAmount,
    taxAmount: values.taxAmount,
  }));
}

function formatDate(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}


function formatDecimal(value: number): string {
  return value.toFixed(2);
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

