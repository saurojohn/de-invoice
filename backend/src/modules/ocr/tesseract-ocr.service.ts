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
    const worker = await this.getWorker()

    // tesseract.js expects a Buffer (Node), Blob, or
    // URL. We pass the Node Buffer straight through.
    const t0 = Date.now()
    const { data } = await worker.recognize(imageBuffer)
    const elapsed = Date.now() - t0

    const text: string = data.text ?? ''
    this.logger.log(
      `OCR done in ${elapsed}ms — ${text.length} chars`,
    )

    // Run the existing regex extractors. They were
    // designed against German receipt text (Musterfirma
    // GmbH, "EUR"-prefixed amounts, dd.mm.yyyy dates)
    // so the same parser works for both mock + real.
    const extracted = extractFieldsFromText(text)

    return {
      ...extracted,
      // Always populate rawText so the UI's
      // "OCR Rohtext anzeigen" accordion shows
      // what the engine actually saw — useful for
      // debugging bad scans.
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