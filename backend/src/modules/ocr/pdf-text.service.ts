// Tier 34: PDF text extraction via pdfjs-dist.
//
// Most B2B invoices in Germany are digital PDFs —
// Word/InDesign exports with a real text layer.
// pdfjs-dist v4 (legacy build) parses these without
// any native deps (no ghostscript, no node-canvas).
// We just call getTextContent() per page and concat.
//
// Limitations (deliberate):
//   - Scanned PDFs (image-only) have no text layer.
//     pdfjs returns an empty string per page. We
//     surface this to the caller with a typed error
//     'no_text_layer' so the controller can return a
//     clear 415 instead of silently OCR'ing nothing.
//     Tier 35+ can add pdf-to-image + tesseract for
//     the scanned case, but the scope is "B2B digital
//     invoices" for now.
//   - The pdfjs-dist build path is the legacy build
//     (no workers, no canvas). pdfjs-dist v4 without
//     workers still runs synchronously in node — fine
//     for the modest PDF sizes we expect (a few MB max,
//     controller already caps at 10MB).
//
// API:
//   PdfTextService.extractText(pdfBuffer): Promise<string>
//     Returns the concat'd text across all pages.
//     Returns '' if all pages have no text layer (the
//     caller decides what to do).
//   PdfTextService.extractPages(pdfBuffer): string[]
//     Per-page array (handy for debugging).

import { Injectable, Logger } from '@nestjs/common'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

@Injectable()
export class PdfTextService {
  private readonly logger = new Logger(PdfTextService.name)

  /**
   * Extract text from a PDF buffer. Returns the concat
   * of all pages, separated by '\n\n' between pages.
   * Throws 'no_text_layer' (string-tagged sentinel) if
   * every page returns empty text — that's the scanned-
   * PDF case the caller should fail fast on.
   */
  async extractText(buffer: Buffer): Promise<string> {
    const pages = await this.extractPages(buffer)
    if (pages.every((p) => !p.trim())) {
      // Sentinel — controller turns this into 415.
      throw new Error('no_text_layer')
    }
    return pages.join('\n\n')
  }

  /** Per-page text array. Used by tests + for multi-page debug logs. */
  async extractPages(buffer: Buffer): Promise<string[]> {
    const t0 = Date.now()
    // Uint8Array view into the buffer. pdfjs doesn't
    // accept Node Buffer directly — it expects a typed
    // array.
    const data = new Uint8Array(buffer.byteLength)
    data.set(buffer)
    // useSystemFonts avoids pdfjs trying to load
    // font files from disk — we don't need them for
    // text extraction (only for rendering).
    // isEvalSupported: false — pdfjs' eval isn't safe
    // in the slim Docker image (no /usr/bin/node-gyp)
    // and we don't need it.
    const doc = await getDocument({
      data,
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
    }).promise
    const out: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      // Each item carries a `hasEOL` flag — true when
      // the source text ended with a line break. We
      // honour it so the downstream regex extractors
      // see the same shape as an OCR-passed scan
      // (lines separated by '\n'). Without this, the
      // extractor's "first line = supplier name" logic
      // gets a single concatenated string and misses.
      const lines = tc.items.map((it: any) =>
        typeof it.str === 'string' ? it.str : '',
      )
      let text = ''
      for (let j = 0; j < lines.length; j++) {
        text += lines[j]
        // hasEOL means a newline follows in the PDF
        // text flow. We append '\n' so the per-line
        // extractors (supplier name etc.) see proper
        // line breaks.
        const item: any = tc.items[j]
        if (item?.hasEOL) text += '\n'
        else if (j < lines.length - 1) text += ' '
      }
      out.push(text)
      try {
        page.cleanup()
      } catch {
        /* ignore */
      }
    }
    try {
      doc.destroy()
    } catch {
      /* ignore */
    }
    this.logger.log(
      `PDF parsed in ${Date.now() - t0}ms — ${doc.numPages} page(s), ${out.join('').length} chars`,
    )
    return out
  }

  /**
   * Magic-bytes detection. We can't use the file
   * extension or just mimetype because the front-end
   * may send `application/octet-stream` for an
   * arbitrary upload. The signature is always
   * `%PDF-` at byte offset 0.
   */
  looksLikePdf(buffer: Buffer): boolean {
    if (buffer.length < 5) return false
    return (
      buffer[0] === 0x25 && // %
      buffer[1] === 0x50 && // P
      buffer[2] === 0x44 && // D
      buffer[3] === 0x46 && // F
      buffer[4] === 0x2d    // -
    )
  }
}