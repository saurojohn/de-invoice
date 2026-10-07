// Tier 31: Real OCR via tesseract.js.
//
// This module wraps the `tesseract.js` npm package
// (pure-JS OCR engine — no native binary needed,
// traineddata is downloaded on first run).
//
// Pipeline:
//
//   PNG/JPG buffer
//     → tesseract.createWorker('deu')
//     → worker.recognize(buffer)
//     → text
//     → extractFieldsFromText(text)   ← same regex
//                                       extractors as
//                                       MockOcrService,
//                                       so both backends
//                                       produce the same
//                                       ReceiptData shape.
//
// Why a separate class (not a flag in MockOcrService):
//
//   Nest DI lets us swap the provider via useClass
//   in OcrModule. The controller depends on the
//   abstract OcrService class, so the swap is
//   transparent. This keeps the worker + traineddata
//   download out of the dev / CI path where we use
//   the mock (faster, deterministic, no network).
//
// Env switch:
//
//   OCR_ENGINE=tesseract   → use TesseractOcrService
//   OCR_ENGINE=mock (default) → use MockOcrService
//
// First-run latency: ~3-5s (tesseract.js loads the
// 'deu' traineddata from the CDN or local cache).
// Subsequent calls reuse the same worker — ~1s per
// page. We instantiate the worker lazily on the
// first extractReceipt() call so cold-start cost
// doesn't block Nest's boot.

import { BadRequestException, HttpException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import {
  ReceiptData,
  extractFieldsFromText,
  OcrService,
} from './ocr.service'
import { PdfTextService } from './pdf-text.service'
// tesseract.js has no official type exports in v7 —
// import the runtime + use the bare API.
import { createWorker, Worker as TesseractWorker } from 'tesseract.js'

/** The image formats tesseract reads, by their first bytes. */
function looksLikeImage(b: Buffer): boolean {
  if (!b || b.length < 12) return false
  const is = (...bytes: number[]) => bytes.every((v, k) => b[k] === v)
  return (
    is(0x89, 0x50, 0x4e, 0x47) || // PNG
    is(0xff, 0xd8, 0xff) || // JPEG
    is(0x47, 0x49, 0x46, 0x38) || // GIF
    is(0x42, 0x4d) || // BMP
    is(0x49, 0x49, 0x2a, 0x00) || is(0x4d, 0x4d, 0x00, 0x2a) || // TIFF
    (is(0x52, 0x49, 0x46, 0x46) && b.subarray(8, 12).toString('latin1') === 'WEBP')
  )
}

@Injectable()
export class TesseractOcrService
  extends OcrService
  implements OnModuleDestroy
{
  private readonly logger = new Logger(TesseractOcrService.name)
  private worker: TesseractWorker | null = null
  private workerPromise: Promise<TesseractWorker> | null = null

  /**
   * Tier 34: inject PdfTextService so we can handle PDF
   * uploads without spinning up a tesseract worker
   * (the text-layer extraction is fast + zero-cost).
   *
   * The TesseractOcrService has been renamed conceptually
   * to "real-OCR engine" — it picks between pdfjs-dist
   * (digital PDFs) and tesseract.js (scanned images /
   * scanned PDFs would land here in a Tier 35+).
   */
  constructor(private readonly pdfText: PdfTextService) {
    super()
  }

  /**
   * Lazily instantiate the tesseract.js worker on
   * first call. Subsequent calls reuse the same
   * worker — creating a fresh one per scan would
   * re-download the 15MB 'deu' traineddata every
   * time and dominate the request latency.
   *
   * The worker init is wrapped in a promise so
   * parallel scan requests don't race to create
   * two workers — both wait on the same promise.
   */
  private async getWorker(): Promise<TesseractWorker> {
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise

    this.workerPromise = (async () => {
      this.logger.log(
        'Initialising tesseract.js worker (deu traineddata)…',
      )
      // Tier 566: an errorHandler. Without one tesseract.js THROWS inside the
      // worker thread's message handler whenever a job is rejected — an
      // uncaught exception, and the whole backend process exits. Measured: one
      // upload of a file that is not an image ("Error attempting to read
      // image") took the server down for every company. The job's own promise
      // is rejected as well; that is what the caller sees.
      const w = await createWorker('deu', 1, {
        errorHandler: (e: unknown) => this.logger.warn(`tesseract job failed: ${String(e).slice(0, 200)}`),
      })
      this.logger.log('tesseract.js worker ready')
      this.worker = w
      return w
    })()
    // A failed start (no language data, no network) must not be remembered
    // for good: the next scan tries again.
    this.workerPromise.catch(() => {
      this.workerPromise = null
    })

    return this.workerPromise
  }

  async extractReceipt(imageBuffer: Buffer): Promise<ReceiptData> {
    // Tier 566: a file that cannot be read is the uploader's problem (400),
    // not the server's (it was 500 for a damaged PDF).
    try {
      return await this.read(imageBuffer)
    } catch (err: any) {
      if (err instanceof HttpException) throw err
      this.logger.warn(`receipt not readable: ${String(err?.message ?? err).slice(0, 200)}`)
      throw new BadRequestException('Die Datei konnte nicht gelesen werden — bitte ein unbeschädigtes PDF oder Bild (PNG, JPG) hochladen.')
    }
  }

  private async read(imageBuffer: Buffer): Promise<ReceiptData> {
    let text = ''
    let source: 'pdf' | 'image' | 'pdf-raster' = 'image'

    // Tier 34: PDF branch. Magic-byte detection — the
    // controller may forward arbitrary bytes with
    // mismatched Content-Type. We use the signature
    // ('%PDF-') instead of trusting the header.
    if (this.pdfText.looksLikePdf(imageBuffer)) {
      // First try the text layer (digital PDFs —
      // Word/Acrobat exports with embedded text).
      let hadTextLayer = false
      try {
        text = await this.pdfText.extractText(imageBuffer)
        hadTextLayer = text.trim().length > 0
      } catch (err: any) {
        // 'no_text_layer' sentinel from PdfTextService —
        // the PDF is image-only (a real "scan").
        if (err?.message !== 'no_text_layer') {
          throw err
        }
      }

      if (hadTextLayer) {
        source = 'pdf'
        this.logger.log(
          `PDF text layer extracted — ${text.length} chars`,
        )
      } else {
        // Tier 35: scanned PDF (no text layer). Rasterize
        // each page via @napi-rs/canvas, OCR each PNG
        // with tesseract. Multi-page texts get concat'd
        // with '\n\n' so per-line extractors see the
        // page break as a separator.
        source = 'pdf-raster'
        const pngs = await this.pdfText.renderPagesToPngs(
          imageBuffer,
          2.0,
        )
        const worker = await this.getWorker()
        const chunks: string[] = []
        for (let i = 0; i < pngs.length; i++) {
          const r = await worker.recognize(pngs[i])
          chunks.push(r.data.text ?? '')
        }
        text = chunks.join('\n\n')
        this.logger.log(
          `PDF rasterised + OCR — ${pngs.length} page(s), ${text.length} chars`,
        )
      }
    } else {
      // Image branch — tesseract.js worker. Lazy-loaded,
      // reused across requests. Falls back gracefully
      // when the buffer is empty / corrupt.
      if (!looksLikeImage(imageBuffer)) {
        throw new BadRequestException('Die Datei ist weder ein PDF noch ein Bild (PNG, JPG, GIF, WebP, BMP, TIFF).')
      }
      const worker = await this.getWorker()
      const t0 = Date.now()
      const { data } = await worker.recognize(imageBuffer)
      const elapsed = Date.now() - t0
      text = data.text ?? ''
      this.logger.log(
        `OCR done in ${elapsed}ms — ${text.length} chars`,
      )
    }

    // Run the existing regex extractors. The same
    // regexes parse tesseract OCR text, pdfjs text layer
    // output, and pdf-raster OCR text — the text shapes
    // are interchangeable for our purposes.
    const extracted = extractFieldsFromText(text)

    return {
      ...extracted,
      // Surface the source in the response so the UI
      // can badge it (helps the user tell a scanned
      // image from a digital PDF from a scanned PDF).
      ...(process.env.NODE_ENV === 'production'
        ? {}
        : { _source: source } as any),
      rawText: text,
    }
  }

  async onModuleDestroy() {
    if (this.worker) {
      try {
        await this.worker.terminate()
      } catch (e: any) {
        this.logger.warn(
          `Failed to terminate tesseract worker: ${e?.message}`,
        )
      }
      this.worker = null
    }
  }
}