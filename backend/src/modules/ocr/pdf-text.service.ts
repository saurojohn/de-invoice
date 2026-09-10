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
// Tier 35: raster fallback for scanned PDFs (no text
// layer). pdfjs-dist's getTextContent() returns empty
// for image-only PDFs — we rasterize each page to a
// PNG via the @napi-rs/canvas factory and hand the
// buffers to tesseract.js for OCR.
//
// Why @napi-rs/canvas instead of node-canvas:
//   - node-canvas builds a N-API wrapper around
//     cairo, which needs the cairo dev headers at
//     install time. Our slim Docker image doesn't have
//     those.
//   - @napi-rs/canvas uses prebuilt .node binaries
//     (Rust + skia) — installs cleanly in any node
//     ABI-compatible image. No toolchain in the
//     runtime image. Skia handles PDF raster natively
//     (and is the same engine that Chrome uses).
import { createCanvas, type SKRSContext2D, type Canvas } from '@napi-rs/canvas'

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

  /**
   * Tier 35: rasterize PDF pages to PNGs for OCR.
   *
   * `scale` controls dpi — 2.0 gives ~144 DPI which is
   * plenty for German receipts (A4 = 595×842pt at 1.0).
   * Higher dpi slows tesseract without much accuracy gain.
   *
   * Returns an array of PNG buffers (one per page). The
   * caller passes each buffer to tesseract.recognize()
   * and concatenates the resulting text.
   */
  async renderPagesToPngs(
    buffer: Buffer,
    scale = 2.0,
  ): Promise<Buffer[]> {
    const t0 = Date.now()
    const data = new Uint8Array(buffer.byteLength)
    data.set(buffer)
    const doc = await getDocument({
      data,
      useSystemFonts: true,
      isEvalSupported: false,
      // pdfjs render needs FontFace disabled to fall
      // back to the system Helvetica — we render
      // with the embedded fonts pdfjs can resolve.
      // disableFontFace=false here so pdfjs renders
      // Cyrillic / accented glyphs correctly.
      disableFontFace: false,
    }).promise
    const pngs: Buffer[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale })
      // Factory injection: pdfjs calls create() per
      // page render. @napi-rs/canvas uses synchronous
      // getContext('2d') so the rendered surface is
      // ready by the time page.render() resolves.
      const canvas: Canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      )
       
      const ctx = (canvas as any).getContext('2d') as SKRSContext2D
      // Fill white background — pdfjs render is
      // transparent by default; tesseract needs a
      // light background for the model to find the
      // text reliably.
       
      ;(ctx as any).fillStyle = '#ffffff'
       
      ;(ctx as any).fillRect(0, 0, canvas.width, canvas.height)
      await page.render({
        canvasContext: ctx,
        viewport,
        canvasFactory: {
          // pdfjs-dist 4.x passes {width, height} as a
          // single { width, height } object on create().
          create: (w: number, h: number) => createCanvas(w, h),
          reset: (c: CanvasAndContext, w: number, h: number) => {
            c.canvas.width = w
            c.canvas.height = h
          },
          destroy: (_: CanvasAndContext) => {
            /* no-op — @napi-rs/canvas finalizes on GC */
          },
        },
      } as any).promise
      // toBuffer() returns Buffer (Node) when the
      // 'image/png' format is requested. tesseract.js
      // accepts Buffer directly.
      const png = (canvas as any).toBuffer('image/png') as Buffer
      pngs.push(png)
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
      `PDF rasterized in ${Date.now() - t0}ms — ${doc.numPages} page(s), ${pngs.reduce((s, b) => s + b.length, 0)} bytes`,
    )
    return pngs
  }
}

/**
 * pdfjs' CanvasFactory types use a different shape than
 * our @napi-rs/canvas (which IS what the factory creates).
 * We declare a minimal local type here so the cast stays
 * inside renderPagesToPngs (avoiding "any" leakage).
 */
interface CanvasAndContext {
  canvas: Canvas
  context: SKRSContext2D
}