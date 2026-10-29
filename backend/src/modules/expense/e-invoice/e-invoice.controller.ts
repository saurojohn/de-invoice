import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req, UploadedFile } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Auth, Require } from '../../../auth/roles.decorator'
import { CallerBoundUpload } from '../../../auth/caller-bound-upload'
import { EInvoiceImportService, ImportOptions } from './e-invoice-import.service'

type Upload = { buffer: Buffer; originalname: string; mimetype: string; size: number }

const UPLOAD = { limits: { fileSize: 10 * 1024 * 1024 } }
const truthy = (v: unknown) => v === true || v === 'true' || v === '1'

/**
 * Tier 573 — incoming e-invoices (XRechnung UBL / CII, ZUGFeRD / Factur-X).
 *
 *   POST /expenses/e-invoice/preview   file → what is in it and what an import would do
 *   POST /expenses/e-invoice/import    file → supplier, expense(s), the file kept as Beleg
 *   POST /expenses/e-invoice/validate  file → the official KoSIT check, where installed
 *   GET  /expenses/:id/e-invoice       the kept e-invoice of an expense, readable
 */
@Auth()
@Controller('expenses')
export class EInvoiceController {
  constructor(private readonly eInvoices: EInvoiceImportService) {}

  @Post('e-invoice/preview')
  @HttpCode(200) // nothing is created
  @Require('invoice.create')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @CallerBoundUpload('file', UPLOAD)
  async preview(
    @UploadedFile() file: Upload | undefined,
    @Query('companyId') companyId: string,
    @Body() body: Record<string, unknown>,
  ) {
    this.check(companyId, file)
    return this.eInvoices.preview(companyId, file!.buffer, this.options(body))
  }

  @Post('e-invoice/import')
  @Require('invoice.create')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @CallerBoundUpload('file', UPLOAD)
  async import(
    @UploadedFile() file: Upload | undefined,
    @Query('companyId') companyId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: { user?: { id?: string } },
  ) {
    this.check(companyId, file)
    return this.eInvoices.import(
      companyId,
      req.user?.id,
      { buffer: file!.buffer, originalName: file!.originalname, mimeType: file!.mimetype },
      this.options(body),
    )
  }

  /**
   * The official validator (KoSIT) on a received file — against EN 16931
   * (Tier 738: scenarios-en16931.xml). It used the XRechnung scenarios, which
   * rejected a Peppol BIS or plain EN 16931 UBL invoice for BR-DE-21 alone.
   * Since Tier 738 the import dialog asks for it beside the preview (the
   * preview does not wait for Java), and the import uses its verdict.
   */
  @Post('e-invoice/validate')
  @HttpCode(200)
  @Require('invoice.create')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @CallerBoundUpload('file', UPLOAD)
  async validate(@UploadedFile() file: Upload | undefined, @Query('companyId') companyId: string) {
    this.check(companyId, file)
    const read = await this.eInvoices.read(file!.buffer)
    if (!read) throw new BadRequestException('Die PDF-Datei enthält keine E-Rechnung (keine eingebettete XML-Datei).')
    // the verdict is kept for the import of the same file (Tier 738)
    const { raw } = await this.eInvoices.runEn16931(file!.buffer, read)
    if (!raw) return { available: false, profile: read.invoice.profile, message: 'Der KoSIT-Validator ist auf diesem Server nicht installiert.' }
    return { available: true, profile: read.invoice.profile, ...raw }
  }

  @Get(':id/e-invoice')
  @Require('invoice.read')
  async forExpense(@Param('id') id: string, @Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.eInvoices.forExpense(companyId, id)
  }

  private check(companyId: string, file: Upload | undefined) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!file || !file.buffer?.length) throw new BadRequestException('Keine Datei hochgeladen.')
  }

  /** multipart fields arrive as strings */
  private options(body: Record<string, unknown> | undefined): ImportOptions {
    const b = body || {}
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
    const opts: ImportOptions = {
      supplierId: str(b.supplierId, 64),
      confirmDuplicate: truthy(b.confirmDuplicate),
      confirmRecipient: truthy(b.confirmRecipient),
      paidAt: str(b.paidAt, 30),
      category: str(b.category, 100),
      accountNumber: str(b.accountNumber, 20),
    }
    if (b.exchangeRate !== undefined && b.exchangeRate !== '') {
      const rate = Number(typeof b.exchangeRate === 'string' ? b.exchangeRate.replace(',', '.') : b.exchangeRate)
      if (!Number.isFinite(rate) || rate <= 0) throw new BadRequestException('Der Umrechnungskurs muss eine positive Zahl sein.')
      opts.exchangeRate = rate
    }
    if (opts.paidAt && !/^\d{4}-\d{2}-\d{2}/.test(opts.paidAt)) throw new BadRequestException('Bezahlt am muss ein Datum sein (JJJJ-MM-TT).')
    return opts
  }
}
