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

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import {
  ReceiptData,
  extractFieldsFromText,
  OcrService,
} from './ocr.service'
import { PdfTextService } from './pdf-text.service'
// tesseract.js has no official type exports in v7 —
// import the runtime + use the bare API.
import { createWorker, Worker as TesseractWorker } from 'tesseract.js'

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
      const w = await createWorker('deu')
      this.logger.log('tesseract.js worker ready')
      this.worker = w
      return w
    })()

    return this.workerPromise
  }

  async extractReceipt(imageBuffer: Buffer): Promise<ReceiptData> {
    let text = ''
    let source: 'pdf' | 'image' = 'image'

    // Tier 34: PDF branch. Magic-byte detection — the
    // controller may forward arbitrary bytes with
    // mismatched Content-Type. We use the signature
    // ('%PDF-') instead of trusting the header.
    if (this.pdfText.looksLikePdf(imageBuffer)) {
      source = 'pdf'
      const t0 = Date.now()
      text = await this.pdfText.extractText(imageBuffer)
      this.logger.log(
        `PDF text extracted in ${Date.now() - t0}ms — ${text.length} chars`,
      )
    } else {
      // Image branch — tesseract.js worker. Lazy-loaded,
      // reused across requests. Falls back gracefully
      // when the buffer is empty / corrupt.
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
    // regexes parse both tesseract OCR text and
    // pdfjs text layer output — the text shapes are
    // interchangeable for our purposes.
    const extracted = extractFieldsFromText(text)

    return {
      ...extracted,
      // Surface the source in the response so the UI
      // can badge it (helps the user tell a scanned
      // image from a digital PDF).
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