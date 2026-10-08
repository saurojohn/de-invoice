import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req, UploadedFile } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Auth, Require } from '../../../auth/roles.decorator'
import { CallerBoundUpload } from '../../../auth/caller-bound-upload'
import { KoSITValidatorUnavailableError, validateXRechnungWithKoSIT } from '../../../invoices/kosIT-validator.service'
import { EInvoiceImportService, ImportOptions } from './e-invoice-import.service'
import { embeddedXmlFiles } from './pdf-embedded-xml'
import { decodeXml } from './xml-reader'

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
   * The official validator (KoSIT, XRechnung scenarios) on a received file.
   * It answers whether the document is a valid XRechnung; an EN 16931 invoice
   * of another profile (ZUGFeRD COMFORT) matches none of its scenarios.
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
    let xml: string
    if (read.source === 'pdf') {
      const embedded = (await embeddedXmlFiles(file!.buffer)).find((f) => f.filename === read.embeddedFile)
      xml = decodeXml(embedded!.content)
    } else {
      xml = decodeXml(file!.buffer)
    }
    try {
      return { available: true, profile: read.invoice.profile, ...(await validateXRechnungWithKoSIT(xml)) }
    } catch (e) {
      if (e instanceof KoSITValidatorUnavailableError) {
        return { available: false, profile: read.invoice.profile, message: 'Der KoSIT-Validator ist auf diesem Server nicht installiert.' }
      }
      throw e
    }
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
