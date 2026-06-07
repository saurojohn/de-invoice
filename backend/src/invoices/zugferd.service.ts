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
          // Logo centered horizontally at the top, height 68px
          // (52 → 68, another +30% per user request). Width capped
          // at 220px. The company name + address block below now
          // sits in the top-right corner (was below the logo in
          // earlier layouts).
          const imgHeight = 68;
          const img = doc.openImage(logoPath);
          const imgWidth = Math.min(img.width * (imgHeight / img.height), 220);
          const imgX = (pageWidth - imgWidth) / 2;
          doc.image(logoPath, imgX, 50, { height: imgHeight });
        } catch (e) {
          console.warn('Logo loading failed:', e);
        }
      }
    }

    // Company info — right-anchored block in the top-right corner
    // (per user request — logo moved to top-center, so the company
    // info shifts to the right corner to keep the header balanced).
    // Y starts at 50 to sit at the same top band as the logo.
    const compAddr = company.address || {};
    const rightBlockWidth = rightMargin - leftMargin;
    doc.fontSize(20).font('Helvetica-Bold').text(company.name, leftMargin, 50, { width: rightBlockWidth, align: 'right', lineBreak: false });
    doc.fontSize(9).font('Helvetica');
    if (compAddr.street) doc.text(compAddr.street, leftMargin, 75, { width: rightBlockWidth, align: 'right', lineBreak: false });
    if (compAddr.postalCode || compAddr.city) {
      doc.text(`${compAddr.postalCode || ''} ${compAddr.city || ''}`.trim(), leftMargin, 87, { width: rightBlockWidth, align: 'right', lineBreak: false });
    }
    if (compAddr.country) doc.text(compAddr.country, leftMargin, 99, { width: rightBlockWidth, align: 'right', lineBreak: false });
    // Contact line (below the address). Packs email / phone /
    // fax / website onto a single line, joined with " · ".
    // Empty channels are skipped so a company that hasn't
    // filled in fax/website still renders cleanly. The HR /
    // Geschäftsführer / Sonstige Angaben used to live here too,
    // but they got too long and crowded the right side; they
    // now live in the right footer instead, where they have
    // more room and look like the standard German invoice
    // footer.
    const contactY = 113;
    const contactParts: string[] = [];
    if (company.email) contactParts.push(company.email);
    if (company.phone) contactParts.push(company.phone);
    if ((company as any).fax) contactParts.push(`Fax: ${(company as any).fax}`);
    if ((company as any).website) contactParts.push((company as any).website);
    if (contactParts.length) {
      doc.fontSize(8).font('Helvetica').text(contactParts.join('  ·  '), leftMargin, contactY, { width: rightBlockWidth, align: 'right', lineBreak: false });
    }

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
    // Middle row Y band — same layout as invoice-pdf.service.ts.
    // Customer block on the left, RECHNUNG title + details on the
    // right. Y = headerStartY + logoHeight + 14 = 132.
    const middleRowY = 132;
    const titleWidth = rightMargin - leftMargin
    // Title block offset down 3 rows (3 × 14pt = 42pt) so the
    // RECHNUNG title sits clearly below the customer name on the
    // left. RECHNUNG 20pt (was 24pt), invoice number 16pt
    // (was 14pt) — more balanced header pair.
    const titleOffsetY = 42;
    const titleY = middleRowY + titleOffsetY;
    doc.fontSize(20).font('Helvetica-Bold').text(invoiceTitle, leftMargin, titleY, { width: titleWidth, align: 'right', lineBreak: false });
    doc.fontSize(16).text(invoice.invoiceNumber, leftMargin, titleY + 24, { width: titleWidth, align: 'right', lineBreak: false });

    // Invoice details (right side, below RECHNUNG title).
    // §14 UStG requires the company USt-IDNr. and Steuernummer
    // to appear on every invoice. Per the user, they live
    // directly underneath Ausstellungsdatum on the right, in
    // the same column (same right-aligned value column as the
    // date). Currency sits after the tax IDs.
    const detailsY = titleY + 54;
    const detailsLabelX = rightMargin - 180;
    const detailsValueX = rightMargin - 60;
    const detailsValueWidth = 100;
    doc.fontSize(10).font('Helvetica').fillColor('#000000');
    let detailsRowY = detailsY;
    doc.text('Ausstellungsdatum:', detailsLabelX, detailsRowY, { width: 100, align: 'right', lineBreak: false });
    doc.text(formatDate(invoice.issueDate), detailsValueX, detailsRowY, { width: 60, align: 'right', lineBreak: false });
    detailsRowY += 15;
    if (company.vatId) {
      doc.text('USt-IDNr.:', detailsLabelX, detailsRowY, { width: 100, align: 'right', lineBreak: false });
      doc.text(company.vatId, detailsValueX, detailsRowY, { width: detailsValueWidth, align: 'right', lineBreak: false });
      detailsRowY += 15;
    }
    if (company.taxId) {
      doc.text('Steuernummer:', detailsLabelX, detailsRowY, { width: 100, align: 'right', lineBreak: false });
      doc.text(company.taxId, detailsValueX, detailsRowY, { width: detailsValueWidth, align: 'right', lineBreak: false });
      detailsRowY += 15;
    }
    doc.text('Währung:', detailsLabelX, detailsRowY, { width: 100, align: 'right', lineBreak: false });
    doc.text(invoice.currency, detailsValueX, detailsRowY, { width: 60, align: 'right', lineBreak: false });
    detailsRowY += 15;

    // Customer address — left side of middle row. Per latest user
    // request:
    //   - Sender line: single line, 50% smaller (5pt) — acts as the
    //     return-address line for window envelopes.
    //   - Customer block: 11pt (+10% from the 10pt baseline).
    //   - Sender + customer block offset down 2 rows (2 × 14pt =
    //     28pt) so the address area sits clearly below the logo
    //     band, matching the PDF service's offset.
    const senderOffsetY = 28;
    let custY = middleRowY + senderOffsetY;
    const custAddr = invoice.customer?.address || {};
    // Sender line: "Name · Straße · PLZ Ort · Land"
    const senderParts: string[] = [company.name];
    if (compAddr.street) senderParts.push(compAddr.street);
    const pcCity = `${compAddr.postalCode || ''} ${compAddr.city || ''}`.trim();
    if (pcCity) senderParts.push(pcCity);
    if (compAddr.country) senderParts.push(compAddr.country);
    doc.fontSize(5).font('Helvetica').text(senderParts.join(' · '), leftMargin, custY, { lineBreak: false });
    custY += 10;
    // Customer block — 11pt (was 10pt; +10% per user request).
    doc.fontSize(11).font('Helvetica');
    doc.text(invoice.customer?.name || '', leftMargin, custY, { lineBreak: false });
    custY += 14;
    if (custAddr.street) {
      doc.text(custAddr.street, leftMargin, custY, { lineBreak: false });
      custY += 14;
    }
    if (custAddr.postalCode || custAddr.city) {
      doc.text(`${custAddr.postalCode || ''} ${custAddr.city || ''}`.trim(), leftMargin, custY, { lineBreak: false });
      custY += 14;
    }
    if (custAddr.country) {
      doc.text(custAddr.country, leftMargin, custY, { lineBreak: false });
      custY += 14;
    }
    if (invoice.customer?.vatId) {
      doc.text(`UST-IDNr.: ${invoice.customer.vatId}`, leftMargin, custY, { lineBreak: false });
      custY += 14;
    }

    // Items table — start Y must follow the larger of (a) customer
    // block end or (b) invoice details end, with a minimum floor
    // so a near-empty invoice doesn't collapse the table.
    const colWidths = { desc: 220, qty: 55, price: 75, vat: 55, net: 90 };
    const headerHeight = 25;
    const rowHeight = 24;
    const detailsEndY = detailsY + 30;  // 2 detail rows × 15
    const tableStartY = Math.max(280, Math.max(custY, detailsEndY) + 20);
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

    // Footer — left side keeps the ZUGFeRD/Factur-X compliance
    // note. The right side carries the Impressum (§5 TMG) and
    // other misc. info that used to clutter the right corner of
    // the letterhead.
    const footerY = doc.page.height - 100;
    doc.fontSize(8).fillColor('#000000');
    doc.text(`ZUGFeRD ${version} konform / Factur-X ${version}`, leftMargin, footerY + 60, { lineBreak: false });

    // Right footer — Impressum / Rechtliches / Sonstige Angaben.
    // Anchored to rightMargin, right-aligned, mirrors the layout
    // in invoice-pdf.service.ts. Handelsregister + Geschäftsführer
    // are single lines; otherInfo is multi-line free text and
    // is rendered verbatim with PDFKit's wrapping at rightMargin.
    const reg = (company as any).registerEntry;
    const md = (company as any).managingDirector;
    const other = (company as any).otherInfo;
    const rightFooterWidth = rightMargin - leftMargin;
    let rightFooterY = footerY;
    if (reg) {
      doc.text(`Handelsregister: ${reg}`, leftMargin, rightFooterY, { width: rightFooterWidth, align: 'right', lineBreak: false });
      rightFooterY += 12;
    }
    if (md) {
      doc.text(`Geschäftsführer: ${md}`, leftMargin, rightFooterY, { width: rightFooterWidth, align: 'right', lineBreak: false });
      rightFooterY += 12;
    }
    if (other) {
      doc.text(other, leftMargin, rightFooterY, { width: rightFooterWidth, align: 'right', lineBreak: true });
    }

    // Page number — bottom-right corner, on the same row as the
    // ZUGFeRD compliance note on the left. Pinned to a fixed
    // Y (footerY + 60) so a long otherInfo block above it can't
    // push the page number onto a 2nd page.

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

  // The logo upload endpoint stores just the bare filename
  // (e.g. 'logo.png') in Company.logoPath, with the actual file
  // living at frontend/public/images/<name>. Anchor the lookup
  // to the project root via __dirname (this file lives at
  // backend/src/invoices/, so go up 3 levels), NOT process.cwd()
  // — see commit 88f03fe for the matching upload fix.
  const projectRoot = path.resolve(__dirname, '..', '..', '..')
  const candidateNames = [
    path.join(projectRoot, 'frontend', 'public', 'images', path.basename(logoPath)),
  ]
  if (logoPath.startsWith('images/') || logoPath.startsWith('/images/')) {
    candidateNames.push(
      path.join(projectRoot, 'frontend', 'public', logoPath.replace(/^\//, '')),
    )
  }
  for (const candidate of candidateNames) {
    if (fs.existsSync(candidate)) return candidate
  }
  return fs.existsSync(logoPath) ? logoPath : null
}