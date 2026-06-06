import { Prisma } from '@prisma/client';

/**
 * XRechnung Service
 * Generates electronic invoices in UBL 2.1 format according to German government standards
 * Based on CEN TS 16931 and the German XRechnung specification
 */

export interface XRechnungSupplier {
  name: string;
  address: {
    street?: string;
    postalCode?: string;
    city?: string;
    country?: string;
  };
  vatId?: string;
  taxId?: string;
  bankInfo?: {
    bankName?: string;
    iban?: string;
    bic?: string;
  };
}

export interface XRechnungCustomer {
  name: string;
  address: {
    street?: string;
    postalCode?: string;
    city?: string;
    country?: string;
  };
  vatId?: string;
  email?: string;
}

export interface XRechnungItem {
  description: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
  vatRate: number;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
}

export interface XRechnungData {
  invoiceNumber: string;
  issueDate: string;
  dueDate?: string;
  currency: string;
  supplier: XRechnungSupplier;
  customer: XRechnungCustomer;
  items: XRechnungItem[];
  subtotal: number;
  totalVat: number;
  total: number;
  notes?: string;
}

/**
 * Generate XRechnung XML in UBL 2.1 format
 * German field labels: Rechnungsnummer, Rechnungsdatum, Lieferant, Kunde
 */
export function generateXRechnung(data: XRechnungData): string {
  const invoiceDate = formatXRechnungDate(data.issueDate);
  const dueDate = data.dueDate ? formatXRechnungDate(data.dueDate) : null;

  // Group VAT by rate for TaxSubtotal
  const vatByRate = groupVatByRate(data.items);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:udt="urn:un:unece:uncefact:data:specification:UnqualifiedDataTypesSchemaModule-2"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">

  <!-- Rechnungsnummer -->
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_1.2</cbc:CustomizationID>
  <cbc:ProfileID>urn:cen.eu:en16931:2017</cbc:ProfileID>

  <!-- Rechnungsnummer / Invoice Number -->
  <cbc:ID>${escapeXml(data.invoiceNumber)}</cbc:ID>

  <!-- Rechnungsdatum / Issue Date -->
  <cbc:IssueDate>${invoiceDate}</cbc:IssueDate>

  ${dueDate ? `<!-- Fälligkeitsdatum / Due Date -->
  <cbc:DueDate>${dueDate}</cbc:DueDate>` : ''}

  <!-- Rechnungsart / Invoice Type Code -->
  <cbc:InvoiceTypeCode listID="UN/ECE 1001" listAgencyID="6">380</cbc:InvoiceTypeCode>

  <!-- Währung / Currency -->
  <cbc:DocumentCurrencyCode listID="ISO 4217 Alpha" listAgencyID="6">${escapeXml(data.currency)}</cbc:DocumentCurrencyCode>

  <!-- Lieferant / Supplier Party (Rechnungssteller) -->
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EMDE">${escapeXml(data.supplier.vatId || data.supplier.taxId || '')}</cbc:EndpointID>
      <cac:PartyName>
        <cbc:Name>${escapeXml(data.supplier.name)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(data.supplier.address.street || '')}</cbc:StreetName>
        <cbc:CityName>${escapeXml(data.supplier.address.city || '')}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(data.supplier.address.postalCode || '')}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${escapeXml(data.supplier.address.country || 'DE')}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:Contact>
        ${data.supplier.bankInfo?.bankName ? `<cbc:Name>${escapeXml(data.supplier.bankInfo.bankName)}</cbc:Name>` : ''}
      </cac:Contact>
      ${data.supplier.vatId ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(data.supplier.vatId)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
    </cac:Party>
  </cac:AccountingSupplierParty>

  <!-- Kunde / Customer Party (Rechnungsempfänger) -->
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${data.customer.vatId ? `<cbc:EndpointID schemeID="EMDE">${escapeXml(data.customer.vatId)}</cbc:EndpointID>` : ''}
      <cac:PartyName>
        <cbc:Name>${escapeXml(data.customer.name)}</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(data.customer.address.street || '')}</cbc:StreetName>
        <cbc:CityName>${escapeXml(data.customer.address.city || '')}</cbc:CityName>
        <cbc:PostalZone>${escapeXml(data.customer.address.postalCode || '')}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>${escapeXml(data.customer.address.country || 'DE')}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      ${data.customer.vatId ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(data.customer.vatId)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>` : ''}
    </cac:Party>
  </cac:AccountingCustomerParty>

  <!-- Zahlungsbedingungen / Payment Terms -->
  <cac:PaymentTerms>
    <cbc:Note>Zahlbar innerhalb von 30 Tagen</cbc:Note>
  </cac:PaymentTerms>

  <!-- Rechnungspositionen / Invoice Lines -->
  ${data.items.map((item, index) => generateInvoiceLine(item, index + 1)).join('\n  ')}

  <!-- Steuerübersicht / Tax Total (VAT Summary) -->
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

  <!-- Gesamtbetrag / Legal Monetary Total -->
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(data.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(data.subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(data.total)}</cbc:TaxInclusiveAmount>
    <cbc:DuePayableAmount currencyID="${escapeXml(data.currency)}">${formatDecimal(data.total)}</cbc:DuePayableAmount>
  </cac:LegalMonetaryTotal>

  ${data.notes ? `<!-- Bemerkungen / Notes -->
  <cac:Note>
    <cbc:Content>${escapeXml(data.notes)}</cbc:Content>
  </cac:Note>` : ''}

</Invoice>`;

  return xml;
}

function generateInvoiceLine(item: XRechnungItem, lineNumber: number): string {
  const unitCode = mapUnitToUNECE(item.unit);
  const vatCategoryId = item.vatRate > 0 ? 'S' : 'E';

  return `<cac:InvoiceLine>
    <cbc:ID>${lineNumber}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${unitCode}">${formatDecimal(item.quantity)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">${formatDecimal(item.netAmount)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Description>${escapeXml(item.description)}</cbc:Description>
      <cbc:Name>${escapeXml(item.description.split('\n')[0])}</cbc:Name>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">${formatDecimal(item.unitPrice)}</cbc:PriceAmount>
    </cac:Price>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="EUR">${formatDecimal(item.vatAmount)}</cbc:TaxAmount>
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
  </cac:InvoiceLine>`;
}

function groupVatByRate(items: XRechnungItem[]): { rate: number; taxableAmount: number; taxAmount: number }[] {
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

function mapUnitToUNECE(unit?: string): string {
  const unitMap: Record<string, string> = {
    'piece': 'C62',
    'stück': 'C62',
    'unit': 'C62',
    'hour': 'HUR',
    'stunde': 'HUR',
    'day': 'DAY',
    'tag': 'DAY',
    'meter': 'MTR',
    'kilogram': 'KGM',
    'kilogramm': 'KGM',
    'liter': 'LTR',
  };
  return unitMap[unit?.toLowerCase() || ''] || 'C62';
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

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Transform Prisma invoice data to XRechnung format
 */
export function transformToXRechnungData(
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
  }
): XRechnungData {
  return {
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate instanceof Date ? invoice.issueDate.toISOString() : invoice.issueDate,
    dueDate: invoice.dueDate ? (invoice.dueDate instanceof Date ? invoice.dueDate.toISOString() : invoice.dueDate) : undefined,
    currency: invoice.currency,
    supplier: {
      name: company.name,
      address: company.address || {},
      vatId: company.vatId || undefined,
      taxId: company.taxId || undefined,
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
    })),
    subtotal: parseFloat(invoice.subtotal.toString()),
    totalVat: parseFloat(invoice.totalVat.toString()),
    total: parseFloat(invoice.total.toString()),
    notes: invoice.notes || undefined,
  };
}