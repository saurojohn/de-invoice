// Tier 29: OCR service for Eingangsrechnung scans.
//
// v1 ships with a deterministic mock implementation
// that returns a pre-built receipt fixture. The
// interface is designed so a future TesseractOcrService
// (wrapping the `tesseract.js` npm package) or a cloud
// OCR provider (Mindee / Google Document AI) can drop in
// without touching the controller or the frontend.
//
// Why mock for v1:
//
//   - tesseract.js is a 60MB+ npm dependency
//     (traineddata + worker) and the local CLI
//     tesseract isn't on PATH in this environment.
//     Installing it as a build-time dep for a
//     dev container is overkill for v1.
//   - The user-facing surface — "upload scan,
//     see extracted fields, edit if wrong, save
//     Expense" — is what ships value. The OCR
//     provider is replaceable.
//   - We can verify the full pipeline with a
//     fixture (e2e 61) and later swap the impl.
//
// The fixture mirrors a typical German Kleinbetrags-
// rechnung shape:
//
//   Musterfirma GmbH
//   Musterstr. 1, 12345 Berlin
//   USt-IDNr. DE123456789
//   Rechnung Nr. 2026-0042
//   Datum: 28.06.2026
//   ...item lines...
//   Zwischensumme netto: 100,00 EUR
//   USt 19%: 19,00 EUR
//   Gesamtbetrag: 119,00 EUR
//   IBAN: DE89 3704 0044 0532 0130 00
//   BIC: COBADEFFXXX
//
// The regex extractors below know how to pick out:
//   - grossAmount (Gesamtbetrag / Summe)
//   - netAmount + vatAmount (Zwischensumme + USt)
//   - vatRate (19% / 7%)
//   - invoiceDate (dd.mm.yyyy)
//   - invoiceNumber (Rechnung Nr. ... / RG-...)
//   - supplierName (first non-numeric line)
//   - supplierVatId (DE + 9 digits)
//   - iban (DE + 18-32 digits)
//   - bic (4 alpha + 2 alpha + 2 alnum + 3 alnum)
//
// The mock returns the SAME fixture every call,
// which makes e2e 61 deterministic.

export interface ReceiptData {
  /** Display name of the supplier (line 1 of the receipt) */
  supplierName: string | null
  /** VAT-ID of the supplier (DE + 9 digits) */
  supplierVatId: string | null
  /** Supplier IBAN (for the bank transfer info) */
  supplierIban: string | null
  /** Supplier BIC (for the bank transfer info) */
  supplierBic: string | null
  /** Invoice / receipt number */
  invoiceNumber: string | null
  /** Date of the invoice (dd.mm.yyyy) */
  invoiceDate: string | null
  /** Net amount (EUR) — € symbol optional, comma decimal */
  netAmount: number | null
  /** VAT rate (decimal: 0.19, 0.07) */
  vatRate: number | null
  /** VAT amount in EUR */
  vatAmount: number | null
  /** Gross amount in EUR */
  grossAmount: number | null
  /** Raw OCR text (for debugging + display in the UI) */
  rawText: string
}

export const OCR_FIXTURE: ReceiptData = {
  supplierName: 'Musterfirma GmbH',
  supplierVatId: 'DE123456789',
  supplierIban: 'DE89370400440532013000',
  supplierBic: 'COBADEFFXXX',
  invoiceNumber: 'RG-2026-0042',
  invoiceDate: '28.06.2026',
  netAmount: 100.0,
  vatRate: 0.19,
  vatAmount: 19.0,
  grossAmount: 119.0,
  rawText: [
    'Musterfirma GmbH',
    'Musterstr. 1, 12345 Berlin',
    'USt-IDNr. DE123456789',
    'Rechnung Nr. RG-2026-0042',
    'Datum: 28.06.2026',
    '',
    '1x Beratungsleistung               100,00 EUR',
    '',
    'Zwischensumme netto:           100,00 EUR',
    'USt 19%:                         19,00 EUR',
    'Gesamtbetrag:                   119,00 EUR',
    '',
    'IBAN: DE89 3704 0044 0532 0130 00',
    'BIC: COBADEFFXXX',
    'Sparkasse Musterstadt',
  ].join('\n'),
}

/**
 * Pure-function extractors. These run against the
 * raw OCR text and pull out structured fields. The
 * regex patterns are tuned for German receipts
 * (decimal comma, dd.mm.yyyy, "EUR" suffix,
 * "Rechnung Nr." prefix). They tolerate whitespace
 * and case.
 *
 * Why pure functions (not methods on a class):
 *   - Unit-testable in isolation (no DI)
 *   - The future TesseractOcrService will call
 *     these on its own OCR output without changes
 */
export function extractFieldsFromText(text: string): ReceiptData {
  return {
    supplierName: extractSupplierName(text),
    supplierVatId: extractVatId(text),
    supplierIban: extractIban(text),
    supplierBic: extractBic(text),
    invoiceNumber: extractInvoiceNumber(text),
    invoiceDate: extractDate(text),
    netAmount: extractNetAmount(text),
    vatRate: extractVatRate(text),
    vatAmount: extractVatAmount(text),
    grossAmount: extractGrossAmount(text),
    rawText: text,
  }
}

// --- helpers below ---

/** First non-empty line that contains letters and isn't a header label. */
function extractSupplierName(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    // Skip lines that look like addresses / IDs / numbers
    if (/^\d/.test(line)) continue
    if (/USt-IDNr|Rechnung|Datum|Zwischensumme|USt \d|Gesamtbetrag|IBAN|BIC/.test(line)) continue
    if (/€|EUR/.test(line)) continue
    if (line.length > 3 && /[A-Za-zÄÖÜäöüß]/.test(line)) {
      return line
    }
  }
  return null
}

/** DE + 9 digits (with optional spaces). */
function extractVatId(text: string): string | null {
  const m = text.match(/DE\s?\d{9}/)
  return m ? m[0].replace(/\s+/g, '') : null
}

/** DE + 18-32 digits (German IBAN). */
function extractIban(text: string): string | null {
  const m = text.match(/DE\s?\d{2}(?:\s?\d{4}){4}(?:\s?\d{0,2})?/)
  return m ? m[0].replace(/\s+/g, '') : null
}

/** 8 or 11 chars: 4 alpha + 2 alpha + 2 alnum + 3 alnum. */
function extractBic(text: string): string | null {
  const m = text.match(/\b[A-Z]{4}[A-Z]{2}(?:[A-Z0-9]{2}(?:[A-Z0-9]{3})?)?\b/)
  return m ? m[0] : null
}

/** "Rechnung Nr." / "RG-Nr" / "Rechnungsnummer" / "Nr." prefix. */
function extractInvoiceNumber(text: string): string | null {
  const m = text.match(/(?:Rechnung(?:s)?(?:nummer)?|RG|Rg)\.?\s*(?:Nr\.?|nr\.?|No\.?)?\s*[:\-]?\s*([A-Z0-9\-/]+)/i)
  return m ? m[1] : null
}

/** First dd.mm.yyyy or dd.mm.yy date. */
function extractDate(text: string): string | null {
  const m = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/)
  if (!m) return null
  // Normalise 2-digit year (26 → 2026).
  let year = m[3]
  if (year.length === 2) year = '20' + year
  return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${year}`
}

/** The "Gesamtbetrag" / "Summe" / "Gesamt" line. */
function extractGrossAmount(text: string): number | null {
  const m = text.match(/(?:Gesamtbetrag|Gesamtbetr|Betrag|Summe|Gesamt|Total|Rechnungsbetrag)[:\s]+([\d.]+,\d{2})\s*(?:EUR|€)?/i)
  return m ? parseGermanAmount(m[1]) : null
}

/** "Zwischensumme netto" / "Netto" — backstop if no gross. */
function extractNetAmount(text: string): number | null {
  const m = text.match(/(?:Zwischensumme(?:\s+netto)?|Netto(?:summe)?|Summe\s+netto)[:\s]+([\d.]+,\d{2})\s*(?:EUR|€)?/i)
  return m ? parseGermanAmount(m[1]) : null
}

/** "USt 19%" / "USt 7%" / "MwSt 19%" */
function extractVatRate(text: string): number | null {
  const m = text.match(/(?:USt|MwSt|VAT)\s+(\d{1,2})\s*%/i)
  return m ? Number(m[1]) / 100 : null
}

/** "USt 19%: 19,00 EUR" — VAT amount. */
function extractVatAmount(text: string): number | null {
  const m = text.match(/(?:USt|MwSt|VAT)\s+\d{1,2}\s*%\s*[:\-]?\s*([\d.]+,\d{2})\s*(?:EUR|€)?/i)
  return m ? parseGermanAmount(m[1]) : null
}

/** "1.234,56" → 1234.56 */
function parseGermanAmount(s: string): number {
  // German: thousand-separator ".", decimal ",".
  return Number(s.replace(/\./g, '').replace(',', '.'))
}
/**
 * Injectable wrapper. The controller talks to
 * this; the wrapper delegates to either the
 * mock (v1) or a future TesseractOcrService.
 * Keeping the wrapper as a class lets us swap
 * implementations via Nest's DI without
 * touching the controller.
 */
import { Injectable } from '@nestjs/common'

@Injectable()
export class OcrService {
  /**
   * v1 mock: always return the fixture.
   * v2 will be: pipe imageBuffer through tesseract.js
   * (worker thread, with the 'deu' traineddata) →
   * text → extractFieldsFromText(text).
   */
  async extractReceipt(_imageBuffer: Buffer): Promise<ReceiptData> {
    return OCR_FIXTURE
  }
}
