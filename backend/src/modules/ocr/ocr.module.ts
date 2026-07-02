import { Module, Logger } from '@nestjs/common'
import { OcrController } from './ocr.controller'
import {
  OcrService,
  MockOcrService,
} from './ocr.service'
import { TesseractOcrService } from './tesseract-ocr.service'

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
@Module({
  controllers: [OcrController],
  providers: [
    {
      provide: OcrService,
      // useClass picks the concrete implementation.
      // The env var is read once at module-init time
      // (Nest reads ConfigService eagerly here).
      useClass:
        process.env.OCR_ENGINE === 'tesseract'
          ? TesseractOcrService
          : MockOcrService,
    },
    MockOcrService,
    TesseractOcrService,
  ],
  exports: [OcrService],
})
export class OcrModule {
  private static readonly logger = new Logger(OcrModule.name)
  constructor() {
    OcrModule.logger.log(
      `OCR engine: ${process.env.OCR_ENGINE === 'tesseract' ? 'tesseract (real)' : 'mock (fixture)'}`,
    )
  }
}