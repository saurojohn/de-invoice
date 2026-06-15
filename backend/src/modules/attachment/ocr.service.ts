/**
 * OCR service — extract text from uploaded files.
 *
 * Supports:
 *   - application/pdf    via pdf-parse
 *   - image/jpeg         stored only (no OCR yet — TBD
 *                        Tesseract integration in a
 *                        later tier)
 *   - image/png          stored only
 *
 * Why pdf-parse and not Tesseract: pdf-parse is
 * lightweight (no native deps, no ~30MB WASM blob,
 * no first-load penalty). For native scanned PDFs
 * (i.e. image-only PDFs with no text layer) we'd
 * need Tesseract; for the common case of a "real"
 * PDF generated from Excel / Word, the text layer
 * is enough and pdf-parse is the right tool.
 *
 * For image-only files (phone photos, scans) we
 * currently skip OCR. The Attachment row is
 * created with ocrText=null, and the user can
 * attach a typed description in the meantime.
 * A future Tier will add Tesseract.js with
 * language packs for de/en/zh/fr.
 *
 * pdf-parse is NOT in package.json yet — install
 * on demand, or stub the import until it's
 * available. The e2e test stubs the OCR service so
 * the test doesn't need a real pdf-parse install.
 */
import { Injectable, Logger } from '@nestjs/common';

export interface OcrResult {
  text: string;
  truncated: boolean;
  pages?: number;
}

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  // Cap the stored OCR text at 200k chars — most
  // invoices are <5k chars, this is a generous
  // upper bound for long contracts. Truncation
  // marker is appended so the user (and the audit
  // trail) can tell the stored text is incomplete.
  private readonly MAX_CHARS = 200_000;

  /**
   * Extract text from a file buffer given its MIME
   * type. Returns null when OCR is not supported
   * for the given type (caller treats null as
   * "no OCR available" and the Attachment row is
   * created with ocrText=null).
   */
  async extractText(
    buffer: Buffer,
    mimeType: string,
  ): Promise<OcrResult | null> {
    if (mimeType === 'application/pdf') {
      return this.extractFromPdf(buffer);
    }
    if (mimeType === 'image/jpeg' || mimeType === 'image/png' ||
        mimeType === 'image/webp' || mimeType === 'image/tiff') {
      // Tesseract integration point: future Tier
      // will load the appropriate language pack
      // (de.traineddata for German invoices etc.)
      // and run Tesseract.recognize() on the buffer.
      return null;
    }
    // .txt — trivial case, the file IS the text.
    if (mimeType === 'text/plain') {
      const text = buffer.toString('utf8');
      return this.truncate(text);
    }
    return null;
  }

  private async extractFromPdf(buffer: Buffer): Promise<OcrResult> {
    try {
      // Lazy import — pdf-parse loads test fixtures
      // on its own module init, which fails in some
      // environments. Wrapping in try/catch + lazy
      // import keeps the OCR service importable
      // even if pdf-parse isn't installed.
      // pdf-parse 2.x changed its export shape from
      // a default function (`pdfParse(buffer)`) to
      // a class (`new PDFParse({data}).getText()`).
      // We support both for portability — newer
      // installs use the class, older still have
      // the function.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod: any = require('pdf-parse')
      let text = ''
      let pages: number | undefined
      if (typeof mod === 'function') {
        const r = await mod(buffer)
        text = r.text || ''
        pages = r.numpages
      } else if (mod.PDFParse) {
        const parser = new mod.PDFParse({ data: buffer })
        const r = await parser.getText()
        text = r.text || ''
        pages = r.pages
      } else {
        throw new Error('unrecognised pdf-parse export shape')
      }
      return this.truncate(text, pages)
    } catch (e: any) {
      this.logger.warn(
        `pdf-parse failed (${e?.message || 'unknown'}) — storing PDF without OCR text`,
      )
      // Return an explicit "empty" result rather than
      // null — the caller treats null as "OCR not
      // supported for this MIME" and stores ocrText
      // as null. A catch-error should still store a
      // marker so the user knows the PDF was readable
      // but extraction failed (vs. unsupported type).
      return { text: '', truncated: false, pages: undefined }
    }
  }

  private truncate(text: string, pages?: number): OcrResult {
    if (text.length <= this.MAX_CHARS) {
      return { text, truncated: false, pages }
    }
    return {
      text: text.slice(0, this.MAX_CHARS) + '…[truncated]',
      truncated: true,
      pages,
    }
  }
}
