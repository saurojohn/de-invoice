import { Module, Logger } from '@nestjs/common'
import { OcrController } from './ocr.controller'
import {
  OcrService,
  MockOcrService,
} from './ocr.service'
import { TesseractOcrService } from './tesseract-ocr.service'
import { PdfTextService } from './pdf-text.service'

/**
 * OCR engine selector.
 *
 *   OCR_ENGINE=tesseract → TesseractOcrService
 *                           (real OCR, ~15MB traineddata
 *                            download on first scan)
 *   OCR_ENGINE=mock (default) → MockOcrService
 *                           (deterministic fixture, no
 *                            network or native deps)
 *
 * Default 'mock' keeps the dev / CI path fast and
 * stable. Flip to 'tesseract' in production by setting
 * the env var in the deployment config (see
 * scripts/start-backend.sh).
 *
 * Switching engines requires a backend restart — the
 * DI graph is wired at boot, not per-request.
 */
/**
 * Tier 557: the mock is for development and the specs. It answers every scan
 * with the same invented receipt (Musterfirma GmbH, 119,00 EUR, an IBAN) —
 * and it was the default everywhere, production included, where the compose
 * file never set OCR_ENGINE: a scanned receipt came back as that one.
 * In production the real engine is the default; `OCR_ENGINE=mock` still
 * selects the mock explicitly.
 */
export function realOcr(): boolean {
  const engine = process.env.OCR_ENGINE
  if (engine === 'tesseract') return true
  if (engine === 'mock') return false
  return process.env.NODE_ENV === 'production'
}

@Module({
  controllers: [OcrController],
  providers: [
    {
      provide: OcrService,
      // useClass picks the concrete implementation.
      // The env var is read once at module-init time
      // (Nest reads ConfigService eagerly here).
      useClass: realOcr() ? TesseractOcrService : MockOcrService,
    },
    MockOcrService,
    TesseractOcrService,
    PdfTextService,
  ],
  exports: [OcrService],
})
export class OcrModule {
  private static readonly logger = new Logger(OcrModule.name)
  constructor() {
    OcrModule.logger.log(
      `OCR engine: ${realOcr() ? 'tesseract (real)' : 'mock (fixture)'}`,
    )
  }
}