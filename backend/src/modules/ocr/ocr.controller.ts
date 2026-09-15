import {
  Controller,
  Post,
  UploadedFile,
  BadRequestException,
  Query,
  Get,
  Body,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { OcrService, OCR_FIXTURE, extractFieldsFromText } from './ocr.service'
import { PrismaService } from '../../prisma/prisma.service'
import { Require } from '../../auth/roles.decorator'
import { CallerBoundUpload } from '../../auth/caller-bound-upload'

/**
 * Tier 29: OCR endpoints for Eingangsrechnung scan ingestion.
 *
 * Workflow (UI):
 *   1. User clicks "Aus Scan hochladen" on the
 *      Expense page → file picker (image / PDF)
 *   2. Frontend POSTs the file to /api/v1/ocr/scan
 *   3. Backend runs OCR (mock fixture in v1) and
 *      returns the structured receipt data
 *   4. User reviews + edits the fields, confirms
 *   5. Frontend POSTs the confirmed fields to
 *      /api/v1/expenses/prefilled (the regular
 *      Expense service then creates the row)
 *
 * The OCR endpoint and the Expense-create endpoint
 * are decoupled — the OCR pipeline could later be
 * swapped (tesseract.js, Mindee, Google Doc AI)
 * without changing the create flow.
 *
 * Auth: HeaderAuthGuard (applied at the controller
 * level via the @UseGuards in the app — search for
 * 'HeaderAuthGuard' in app.module.ts to confirm;
 * the rest of the controllers use @Auth() at method
 * level).
 */
@Controller('ocr')
export class OcrController {
  constructor(
    private readonly ocr: OcrService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * POST /api/v1/ocr/scan
   * multipart/form-data with a single 'file' field.
   * Returns the structured ReceiptData so the UI
   * can prefill the Expense form.
   *
   * v1: ignores the file bytes (we return the
   * fixture). The FileInterceptor is wired up so
   * v2 only needs to swap OcrService.extractReceipt
   * — no controller change.
   *
   * Why we still take the upload: the UI flow needs
   * to validate the file (size, MIME), and the
   * user expects "I uploaded something" feedback.
   * The size cap (10MB) prevents OOM on accidental
   * huge uploads.
   */
  @Require('expense.read')
  @Post('scan')
  // OCR scan — heavy (tesseract / AI call, seconds of CPU).
  // Tight local limit (overrides the global 600/60s):
  // 20 per minute per IP. The "Aus Scan hochladen" button
  // is human-driven; 20/min is plenty even for the
  // accountant who batches a stack of receipts, and the
  // e2e suite which runs scan several times.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @CallerBoundUpload('file', {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (req, file, cb) => {
      // Accept images + PDF. PDF OCR is harder
      // (tesseract needs OCRmyPDF or similar), so
      // the future tesseract impl will branch on
      // mimetype.
      const ok = [
        /^image\//,
        /^application\/pdf$/,
      ].some((re) => re.test(file.mimetype))
      if (!ok) {
        return cb(new BadRequestException(`Nicht unterstütztes Dateiformat: ${file.mimetype}`), false)
      }
      cb(null, true)
    },
  })
  async scan(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('companyId') _companyId: string,
  ) {
    if (!file) {
      throw new BadRequestException('Keine Datei hochgeladen')
    }
    // v1: return the fixture regardless of file
    // content. v2: pipe file.buffer into tesseract.
    const data = await this.ocr.extractReceipt(file.buffer)
    return data
  }

  /**
   * GET /api/v1/ocr/fixture
   * Test-only endpoint that returns the hard-coded
   * fixture. Used by the dev "load sample data"
   * button in the OCR UI so testers can iterate on
   * the field-mapping without an actual scan. Not
   * used by the production e2e (which exercises the
   * full /scan + /expenses/prefilled path).
   */
  @Require('expense.read')
  @Get('fixture')
  fixture() {
    return OCR_FIXTURE
  }

  /**
   * GET /api/v1/ocr/extract?text=...
   * Pure-function smoke test for the regex
   * extractors. Used by e2e 61 + manual debugging
   * ("what does the extractor return for this
   * weird OCR output?"). The text param is URL-
   * encoded by the caller.
   */
  @Require('expense.read')
  @Get('extract')
  extract(@Query('text') text: string) {
    if (!text) {
      throw new BadRequestException('text query param required')
    }
    return extractFieldsFromText(text)
  }

  /**
   * POST /api/v1/ocr/match-supplier
   * Body: { vatId?: string, name?: string }
   * Returns: { supplierId: string, created: boolean }
   *
   * The frontend calls this AFTER the user reviews
   * the OCR-extracted fields. We look up an
   * existing Supplier by VAT-ID first (the
   * most-reliable match — names are noisy in
   * OCR). If no match, we look up by name
   * (case-insensitive startsWith). If still no
   * match, we CREATE a new Supplier with the
   * provided name + vatId + a minimal address
   * (the user can fill in the rest from the
   * Suppliers page).
   *
   * Why we do find-or-create here, not in the
   * frontend: the OCR pipeline is the only
   * place where we have BOTH the raw OCR text
   * (which might have a "Buchhaltung" or other
   * company-department line that LOOKS like a
   * supplier name) AND the structured VAT-ID.
   * Centralising the matching logic here keeps
   * the UI clean.
   */
  @Require('expense.write')
  @Post('match-supplier')
  async matchSupplier(
    @Body() body: { vatId?: string; name?: string; companyId?: string },
    @Query('companyId') companyIdQuery: string,
  ) {
    const companyId = body.companyId || companyIdQuery
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const vatId = (body.vatId || '').trim()
    const name = (body.name || '').trim()
    if (!vatId && !name) {
      throw new BadRequestException('vatId oder name ist erforderlich')
    }
    // 1) Match by VAT-ID — highest confidence.
    if (vatId) {
      const hit = await this.prisma.supplier.findFirst({
        where: { companyId, vatId: { equals: vatId } },
        select: { id: true },
      })
      if (hit) return { supplierId: hit.id, created: false, matchedBy: 'vatId' }
    }
    // 2) Match by name (case-insensitive equality).
    if (name) {
      const hit = await this.prisma.supplier.findFirst({
        where: { companyId, name: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      })
      if (hit) return { supplierId: hit.id, created: false, matchedBy: 'name' }
    }
    // 3) Create a new Supplier with what we have.
    const created = await this.prisma.supplier.create({
      data: {
        companyId,
        name: name || 'Unbekannter Lieferant',
        vatId: vatId || null,
        address: {},
      },
      select: { id: true },
    })
    return { supplierId: created.id, created: true, matchedBy: 'created' }
  }
}