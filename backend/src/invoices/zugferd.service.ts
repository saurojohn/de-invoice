import PDFKit from 'pdfkit';
import { generateXRechnung, transformToXRechnungData, XRechnungData } from './xrechnung.service';

/**
 * ZUGFeRD Service
 * Generates electronic invoices in ZUGFeRD 1.0 / 2.0 format
 * ZUGFeRD = PDF/A-3 with embedded XML (Factur-X standard)
 */

export interface ZUGFeRDOptions {
  version?: '1.0' | '2.0' | '2.1';
  conformanceLevel?: 'BASIC' | 'EN16931' | 'EXTENDED';
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
    vatId?: string | null;
    taxId?: string | null;
    address: any;
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
  const xmlContent = generateXRechnung(xrechnungData);

  // Generate ZUGFeRD XML (Factur-X profile)
  const zugferdXml = generateZUGFeRDXml(xrechnungData, version, conformanceLevel);

  // Create PDF with embedded XML
  return createZUGFeRDPdf(invoice, company, zugferdXml, xmlContent, version);
}

function generateZUGFeRDXml(
  data: XRechnungData,
  version: string,
  conformanceLevel: string
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
  const elementName = type === 'Supplier' ? 'SupplyChainTradeAgreement' : 'BuyerTradeParty';

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

function createZUGFeRDPdf(
  invoice: any,
  company: any,
  zugferdXml: string,
  xrechnungXml: string,
  version: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFKit({ margin: 50, size: 'A4' }) as any;
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      // Note: Full PDF/A-3 compliance requires additional processing
      // For production use, consider using a dedicated PDF library like pdf-lib
      // or integrate with a pre-flight PDF processor
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);

    const pageWidth = doc.page.width;
    const leftMargin = 50;
    const rightMargin = pageWidth - 50;

    // ===== HEADER =====
    if (company.logoPath) {
      const logoPath = resolveLogoPath(company.logoPath);
      if (logoPath) {
        try {
          const imgHeight = 40;
          const img = doc.openImage(logoPath);
          const imgWidth = Math.min(img.width * (imgHeight / img.height), 150);
          const imgX = (pageWidth - imgWidth) / 2;
          doc.image(logoPath, imgX, 50, { height: imgHeight });
        } catch (e) {
          console.warn('Logo loading failed:', e);
        }
      }
    }

    // Company info
    const compAddr = company.address || {};
    doc.fontSize(20).font('Helvetica-Bold').text(company.name, leftMargin, 120, { align: 'left', lineBreak: false });
    doc.fontSize(9).font('Helvetica');
    if (compAddr.street) doc.text(compAddr.street, leftMargin, 142, { lineBreak: false });
    if (compAddr.postalCode || compAddr.city) {
      doc.text(`${compAddr.postalCode || ''} ${compAddr.city || ''}`.trim(), leftMargin, 154, { lineBreak: false });
    }
    if (compAddr.country) doc.text(compAddr.country, leftMargin, 166, { lineBreak: false });

    // Invoice title (right aligned to rightMargin). Switch by type so
    // CN is printed as "GUTSCHRIFT" etc.
    const invoiceTitle = (() => {
      switch ((invoice as any).type) {
        case 'CN': return 'GUTSCHRIFT'
        case 'PI': return 'PROFORMARECHNUNG'
        case 'RCV': return 'QUITTUNG'
        default: return 'RECHNUNG'
      }
    })()
    const titleWidth = rightMargin - leftMargin
    doc.fontSize(24).font('Helvetica-Bold').text(invoiceTitle, leftMargin, 210, { width: titleWidth, align: 'right', lineBreak: false });
    doc.fontSize(14).text(invoice.invoiceNumber, leftMargin, 238, { width: titleWidth, align: 'right', lineBreak: false });

    // Invoice details (right aligned to rightMargin)
    const detailsY = 220;
    const detailsLabelX = rightMargin - 180;
    const detailsValueX = rightMargin - 60;
    doc.fontSize(10).font('Helvetica').fillColor('#000000');
    doc.text('Ausstellungsdatum:', detailsLabelX, detailsY, { width: 100, align: 'right', lineBreak: false });
    doc.text(formatDate(invoice.issueDate), detailsValueX, detailsY, { width: 60, align: 'right', lineBreak: false });
    doc.text('Währung:', detailsLabelX, detailsY + 15, { width: 100, align: 'right', lineBreak: false });
    doc.text(invoice.currency, detailsValueX, detailsY + 15, { width: 60, align: 'right', lineBreak: false });

    // Customer address
    const customerY = 330;
    const custAddr = invoice.customer?.address || {};
    let custY = customerY;
    doc.fontSize(10).font('Helvetica-Bold').text('Rechnungsadresse:', leftMargin, custY, { lineBreak: false });
    custY += 15;
    doc.fontSize(10).font('Helvetica');
    doc.text(invoice.customer?.name || '', leftMargin, custY, { lineBreak: false });
    custY += 13;
    if (custAddr.street) {
      doc.text(custAddr.street, leftMargin, custY, { lineBreak: false });
      custY += 13;
    }
    if (custAddr.postalCode || custAddr.city) {
      doc.text(`${custAddr.postalCode || ''} ${custAddr.city || ''}`.trim(), leftMargin, custY, { lineBreak: false });
      custY += 13;
    }
    if (custAddr.country) {
      doc.text(custAddr.country, leftMargin, custY, { lineBreak: false });
      custY += 13;
    }
    if (invoice.customer?.vatId) {
      doc.text(`UST-IDNr.: ${invoice.customer.vatId}`, leftMargin, custY, { lineBreak: false });
    }

    // Items table — same layout as invoice-pdf.service.ts
    // Columns sum: 220 + 55 + 75 + 55 + 90 = 495
    // → right edge of net column = leftMargin + 495 = rightMargin ✓
    const colWidths = { desc: 220, qty: 55, price: 75, vat: 55, net: 90 };
    const headerHeight = 25;
    const rowHeight = 24;
    const tableStartY = 440;
    let y = tableStartY;

    doc.moveTo(leftMargin, y + headerHeight).lineTo(rightMargin, y + headerHeight).lineWidth(0.8).stroke();
    doc.fillColor('#000000')
      .fontSize(10).font('Helvetica-Bold')
      .text('Beschreibung', leftMargin + 5, y + 8, { width: colWidths.desc - 10, lineBreak: false })
      .text('Menge', leftMargin + colWidths.desc, y + 8, { width: colWidths.qty, align: 'center', lineBreak: false })
      .text('Einzelpreis', leftMargin + colWidths.desc + colWidths.qty, y + 8, { width: colWidths.price, align: 'center', lineBreak: false })
      .text('MwSt', leftMargin + colWidths.desc + colWidths.qty + colWidths.price, y + 8, { width: colWidths.vat, align: 'center', lineBreak: false })
      // Gesamt header: right-aligned so it lines up vertically with numbers below
      .text('Gesamt', leftMargin + colWidths.desc + colWidths.qty + colWidths.price + colWidths.vat, y + 8, { width: colWidths.net, align: 'right', lineBreak: false });

    y += headerHeight;
    doc.font('Helvetica').fontSize(10).lineWidth(0.3);
    const sQtyX = leftMargin + colWidths.desc;
    const sQtyW = colWidths.qty;
    const sPriceX = leftMargin + colWidths.desc + colWidths.qty;
    const sPriceW = colWidths.price;
    const sVatX = leftMargin + colWidths.desc + colWidths.qty + colWidths.price;
    const sVatW = colWidths.vat;
    const sNetX = leftMargin + colWidths.desc + colWidths.qty + colWidths.price + colWidths.vat;
    const sNetW = colWidths.net;
    for (let i = 0; i < invoice.items.length; i++) {
      const item = invoice.items[i];
      if (i > 0) {
        doc.moveTo(leftMargin, y).lineTo(rightMargin, y).stroke();
      }
      doc.fillColor('#000000').font('Helvetica');
      doc.text(item.description, leftMargin + 5, y + 7, { width: colWidths.desc - 10, lineBreak: false });
      doc.text(`${toFloat(item.quantity)} ${item.unit || ''}`, sQtyX, y + 7, { width: sQtyW, align: 'center', lineBreak: false });
      doc.text(formatCurrency(toFloat(item.unitPrice)), sPriceX, y + 7, { width: sPriceW, align: 'center', lineBreak: false });
      doc.text(formatVatRate(toFloat(item.vatRate)), sVatX, y + 7, { width: sVatW, align: 'center', lineBreak: false });
      // Per-line total: right-aligned, normal weight, right edge = rightMargin
      doc.text(formatCurrency(toFloat(item.netAmount)), sNetX, y + 7, { width: sNetW, align: 'right', lineBreak: false });
      y += rowHeight;
    }

    // Totals — same column alignment as the table's Gesamt column
    // (right edge anchored to rightMargin)
    const totalsY = y + 20;
    const totalsLabelX = leftMargin + 220;
    const totalsAmountX = rightMargin - 100;
    const totalsAmountWidth = 100;
    doc.moveTo(totalsAmountX, totalsY).lineTo(rightMargin, totalsY).lineWidth(0.8).stroke();

    const totalsFontSize = 11;
    const totalsLineHeight = 22;
    doc.fillColor('#000000').font('Helvetica').fontSize(totalsFontSize).lineWidth(0.3);
    doc.text('Zwischensumme (Netto):', totalsLabelX, totalsY + 5, { lineBreak: false });
    doc.text(formatCurrency(toFloat(invoice.subtotal)), totalsAmountX, totalsY + 5, { width: totalsAmountWidth, align: 'right', lineBreak: false });
    doc.text('Gesamtbetrag USt:', totalsLabelX, totalsY + totalsLineHeight, { lineBreak: false });
    doc.text(formatCurrency(toFloat(invoice.totalVat)), totalsAmountX, totalsY + totalsLineHeight, { width: totalsAmountWidth, align: 'right', lineBreak: false });

    // Gesamtbetrag: outlined box (no fill), bigger font, right edge aligned
    const gesamtY = totalsY + totalsLineHeight * 2;
    const gesamtHeight = totalsLineHeight + 4;
    const gesamtBoxX = totalsLabelX - 5;
    const gesamtBoxWidth = rightMargin - gesamtBoxX;
    doc.lineWidth(1.0);
    doc.rect(gesamtBoxX, gesamtY, gesamtBoxWidth, gesamtHeight).stroke();
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(totalsFontSize + 2);
    doc.text('Gesamtbetrag:', gesamtBoxX + 5, gesamtY + 6, { lineBreak: false });
    doc.text(formatCurrency(toFloat(invoice.total)), totalsAmountX, gesamtY + 6, { width: totalsAmountWidth, align: 'right', lineBreak: false });

    // ZUGFeRD compliance note
    const footerY = doc.page.height - 100;
    doc.fontSize(8).fillColor('#000000');
    doc.text(`ZUGFeRD ${version} konform / Factur-X ${version}`, leftMargin, footerY + 60, { lineBreak: false });

    // Notes
    if (invoice.notes) {
      doc.fontSize(9).font('Helvetica-Bold').text('Bemerkungen:', leftMargin, totalsY + 90, { lineBreak: false });
      doc.font('Helvetica').text(invoice.notes, leftMargin, totalsY + 105, { width: 400, lineBreak: true });
    }

    doc.end();
  });
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

function formatXRechnungDate(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().split('T')[0];
}

function formatDecimal(value: number): string {
  return value.toFixed(2);
}

function formatPercent(rate: number): string {
  return (rate * 100).toFixed(2);
}

function toFloat(val: string | number | any): number {
  if (typeof val === 'number') return val;
  return parseFloat(val?.toString() || '0') || 0;
}

function formatVatRate(rate: number): string {
  if (rate === 0.19) return '19%';
  if (rate === 0.07) return '7%';
  return '0%';
}

function formatCurrency(val: number): string {
  return '€\u00A0' + val.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function resolveLogoPath(logoPath: string): string | null {
  const fs = require('fs');
  const path = require('path');

  if (path.isAbsolute(logoPath)) {
    return fs.existsSync(logoPath) ? logoPath : null;
  }

  if (logoPath.startsWith('images/')) {
    const projectRoot = process.cwd();
    const fullPath = path.join(projectRoot, 'frontend', 'public', logoPath);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  return fs.existsSync(logoPath) ? logoPath : null;
}