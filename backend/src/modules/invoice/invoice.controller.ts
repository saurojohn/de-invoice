import { Controller, Get, Post, Put, Delete, Body, Param, Query, Res, Header, BadRequestException, HttpCode, Req, NotFoundException, HttpException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response, Request } from 'express';
import { Prisma } from '@prisma/client';
 
const archiverLib: any = require('archiver');
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { CreatePaymentDto, CreateCreditNoteDto, BookPaymentNoticeDto } from './dto/payment-credit-note.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MailService } from '../mail/mail.service';
import { generateInvoicePDF, InvoiceRenderConfig, buildEpcQrPayload } from '../../invoices/invoice-pdf.service';
// Tier 225: standalone GiroCode PNG download. The
// `qrcode` lib is already a backend dep (used by
// invoice-pdf.service.ts since Tier 224 to embed
// the QR in the PDF footer), so we reuse the same
// package for the standalone endpoint.
import QRCode from 'qrcode';
import { generateXRechnung, transformToXRechnungData, validateXRechnung } from '../../invoices/xrechnung.service';
import {
  validateXRechnungWithKoSIT,
  KoSITValidatorUnavailableError,
} from '../../invoices/kosIT-validator.service';
import { generateZUGFeRD } from '../../invoices/zugferd.service';
// Tier 62: USt-Behandlung auto-detector (pure function, no
// DI — we just import and call suggestUstBehandlung()).
import { suggestUstBehandlung, UstSuggestion } from './ust-behandlung-detector';
import { CreateInvoiceDto, UpdateInvoiceDto, UpdateInvoiceStatusDto } from './dto/invoice.dto';
import { Auth, Require } from '../../auth/roles.decorator';
// Tier 129: renderInvoiceEmail + EmailLang moved to
// InvoiceEmailService. The controller still has the
// PDF-generation imports (line 11) for the preview
// endpoints.
import { InvoiceTemplateService } from '../invoice-template/invoice-template.service';
// Tier 129: see comment on the constructor.
import { InvoiceEmailService } from './invoice-email.service';
// Tier 165: embed a PAdES-style PDF signature
// into every downloaded invoice. signing.service
// was added in Tier 72; the cert/key live on
// Company.settings.signing (auto-generated on
// first call). The signing happens AFTER the
// PDF is generated + saved, so any signing
// failure still serves the unsigned PDF (and
// the headers say X-PDF-Signed: false) — we
// never want a signing outage to block an
// invoice download.
import { SigningService } from '../signing/signing.service';
// Tier 140: reuses the existing AttachmentsService
// for the invoice-level Belege proxy endpoints
// (list + delete). The upload itself goes through
// the /attachments endpoint directly so the storage
// + OCR + content-hash pipeline is shared.
import { AttachmentsService } from '../attachment/attachments.service';
import { BulkSendInvoiceEmailDto, SendInvoiceEmailDto } from './dto/send-invoice-email.dto';

@Auth()
@Controller('invoices')
export class InvoiceController {
  constructor(
    private invoiceService: InvoiceService,
    private prisma: PrismaService,
    private storageService: StorageService,
    private mailService: MailService,
    private templateService: InvoiceTemplateService,
    private paymentService: PaymentService,
    // Tier 129: extracted the email-send workflow.
    // Controller still owns the route + permission
    // check, then delegates to the service.
    private invoiceEmailService: InvoiceEmailService,
    // Tier 140: invoice-level attachment list/delete.
    private attachmentsService: AttachmentsService,
    // Tier 165: PDF signing for GoBD § 146 AO
    // "unveränderbare Speicherung" compliance.
    private signingService: SigningService,
  ) {}

  /**
   * Tier 39: GET /invoices/cost-centers — list the
   * distinct non-null `costCenter` values that the
   * company has stamped on past invoices. The Invoice
   * form uses this list to populate the dropdown in
   * the cost-center picker, but the user is free to
   * type any other value (the column is free-form,
   * not FK-restricted — DATEV imports commonly bring
   * ad-hoc codes that aren't in this list).
   *
   * Sorted alphabetically, deduped by Prisma's
   * distinct(). We also surface `costObject` pairs
   * in case the UI wants to drill in — but only when
   * the optional `?costCenter=` filter is set, to keep
   * the default response small.
   */
  @Get('cost-centers')
  @Require('invoice.read')
  async listCostCenters(
    @Query('companyId') companyId: string,
    @Query('costCenter') costCenter?: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const costCenters = await this.prisma.invoice.findMany({
      where: { companyId, costCenter: { not: null } },
      select: { costCenter: true },
      distinct: ['costCenter'],
      orderBy: { costCenter: 'asc' },
    })
    const list = costCenters
      .map((r) => r.costCenter)
      .filter((x): x is string => !!x && x.trim().length > 0)
    const result: { costCenters: string[]; costObjects?: string[] } = {
      costCenters: list,
    }
    if (costCenter) {
      const costObjects = await this.prisma.invoice.findMany({
        where: { companyId, costCenter, costObject: { not: null } },
        select: { costObject: true },
        distinct: ['costObject'],
        orderBy: { costObject: 'asc' },
      })
      result.costObjects = costObjects
        .map((r) => r.costObject)
        .filter((x): x is string => !!x && x.trim().length > 0)
    }
    return result
  }

  /**
   * Tier 62: USt-Behandlung auto-detection.
   *
   * Returns the suggested USt treatment for a (customer,
   * company) pair so the invoice-create form can prefill
   * the radio button. The user can always override — this
   * is a hint, not a constraint.
   *
   * Decision tree (see ust-behandlung-detector.ts for full
   * details):
   *   - Customer has VAT ID + same country as company
   *     → standard (Inland B2B)
   *   - Customer has VAT ID + different EU country
   *     → euTransaction (§1a UStG innergemeinschaftliche
   *       Lieferung; or §13b UStG Reverse Charge for B2B
   *       services — the Berater picks the right one)
   *   - Customer has VAT ID + non-EU country
   *     → standard (Ausfuhrlieferung)
   *   - Customer has no VAT ID + EU country
   *     → standard (B2C domestic)
   *   - Customer has no VAT ID + non-EU
   *     → standard (export)
   *
   * The endpoint is read-only (GET) and stateless — it
   * doesn't create any DB rows. The detector itself is a
   * pure function with no I/O, so the response is
   * deterministic given the inputs.
   *
   * Path declared BEFORE `:id` to avoid Nest's route-
   * order gotcha — a customer id of "ust-behandlung-
   * suggestion" would otherwise capture the `:id` route.
   */
  @Get('ust-behandlung-suggestion')
  @Require('invoice.read')
  async ustBehandlungSuggestion(
    @Query('companyId') companyId: string,
    @Query('customerId') customerId: string,
  ): Promise<UstSuggestion> {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!customerId) throw new BadRequestException('customerId ist erforderlich')

    // Fetch both records in parallel — the detector only
    // needs a handful of fields so the projection is tight.
    const [customer, company] = await Promise.all([
      this.prisma.customer.findFirst({
        where: { id: customerId, companyId },
        select: {
          vatId: true,
          address: true,
          taxExempt: true,
        },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { vatId: true, address: true },
      }),
    ])
    if (!customer) {
      throw new BadRequestException('Kunde nicht gefunden')
    }
    if (!company) {
      throw new BadRequestException('Unternehmen nicht gefunden')
    }
    const customerAddress = (customer.address as Record<string, any>) || {}
    return suggestUstBehandlung({
      customerVatId: customer.vatId,
      customerCountry: customerAddress.country ?? null,
      customerTaxExempt: customer.taxExempt,
      companyVatId: company.vatId,
      companyCountry:
        ((company.address as Record<string, any>) || {}).country ?? null,
    })
  }

  @Get()
  @Require('invoice.read')
  async findAll(
    @Query('companyId') companyId: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.invoiceService.findAll(companyId, {
      status,
      customerId,
      type,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      dateFrom,
      dateTo,
    });
  }

  // Bulk-download several invoices as a single ZIP. Each invoice is
  // generated as PDF and placed under a folder named after its
  // invoiceNumber so the user gets an organized bundle.
  // Body: { invoiceIds: string[]; dateFrom?: string; dateTo?: string;
  //         type?: string; status?: string; format?: 'pdf' | 'zugferd' }
  // Query: ?companyId=...
  // Limit: 100 invoices per request to keep response size sane.
  //
  // Two selection modes:
  //   1) invoiceIds[]  — explicit IDs (e.g. user selected rows in UI)
  //   2) dateFrom/dateTo (+ optional type/status) — server picks
  //      matching invoices. Used for date-range exports.
  @Post('bulk-download')
  @Require('invoice.read')
  // Bulk PDF download: server reads N invoices +
  // streams a ZIP. Heavy (memory + CPU). Tight local
  // limit (overrides the global 600/60s): 10 per
  // minute per IP. The "Alle ausgewählten als ZIP
  // herunterladen" button is human-driven; 10/min is
  // plenty for a single user.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async bulkDownload(
    @Body() body: {
      invoiceIds?: string[];
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      status?: string;
      format?: 'pdf' | 'zugferd';
    },
    @Query('companyId') companyId: string,
    @Res() res: Response,
  ) {
    let ids: string[] = []
    if (!companyId) {
      res.status(400).json({ message: 'companyId ist erforderlich' })
      return
    }
    if (Array.isArray(body?.invoiceIds) && body.invoiceIds.length > 0) {
      ids = body.invoiceIds
    } else if (body?.dateFrom || body?.dateTo) {
      const rows = await this.invoiceService.findForExport(companyId, {
        dateFrom: body.dateFrom,
        dateTo: body.dateTo,
        type: body.type,
        status: body.status,
      })
      ids = rows.map((r: any) => r.id)
    }
    if (ids.length === 0) {
      res.status(400).json({ message: 'invoiceIds oder dateFrom/dateTo ist erforderlich' })
      return
    }
    if (ids.length > 100) {
      res.status(400).json({ message: 'Maximal 100 Rechnungen pro Anfrage' })
      return
    }
    // Tier 60: default bulk-download format is now ZUGFeRD
    // (was plain PDF). Matches the single-invoice default
    // so a date-range export produces the same E-Invoice
    // format as a single download. Existing callers that
    // pass `format: 'pdf'` explicitly still get the plain
    // PDF — backwards compatible.
    const format = body?.format === 'pdf' ? 'pdf' : 'zugferd'

    try {
      const company = await this.prisma.company.findUnique({ where: { id: companyId } })
      const companyCtx = {
        name: company?.name || '',
        address: company?.address || {},
        vatId: company?.vatId || undefined,
        taxId: company?.taxId || undefined,
        bankInfo: company?.bankInfo || undefined,
        logoPath: company?.logoPath || undefined,
      }

      const zip = new (archiverLib as any).ZipArchive({ zlib: { level: 6 } })
      const stamp = new Date().toISOString().slice(0, 10)
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="Rechnungen_${stamp}.zip"`,
      })
      zip.pipe(res)

      let okCount = 0
      const failed: Array<{ id: string; number: string; reason: string }> = []
      // Deduplicate invoice numbers so duplicate invoiceNumbers (which
      // shouldn't happen but might during data imports) don't clobber
      // each other in the zip.
      const usedNames = new Set<string>()

      for (const id of ids) {
        try {
          const invoice = await this.invoiceService.findOne(id, companyId)
          if (!invoice) {
            failed.push({ id, number: id, reason: 'not found' })
            continue
          }
          let buffer: Buffer
          let ext: string
          if (format === 'zugferd') {
            buffer = await generateZUGFeRD(invoice, companyCtx as any)
            ext = 'pdf'
          } else {
            // Tier 7.5: resolve the visual
            // config (color/font/density/
            // footer) from the InvoiceTemplate
            // row before rendering. Falls
            // back to the built-in hard-coded
            // 'standard' look when the
            // company has no template set.
            const renderConfig = await this.resolveTemplateConfig(
              invoice.companyId,
              invoice.templateType || 'standard',
              (invoice as any).templateId,
            )
            buffer = await generateInvoicePDF(
              invoice,
              companyCtx as any,
              invoice.templateType || 'standard',
              renderConfig,
            )
            ext = 'pdf'
          }
          let name = invoice.invoiceNumber || id
          // Disambiguate by appending -2, -3, ... if needed
          let unique = name
          let n = 2
          while (usedNames.has(unique)) {
            unique = `${name}-${n++}`
          }
          usedNames.add(unique)
          zip.append(buffer, { name: `${unique}.${ext}` })
          okCount++
        } catch (e: any) {
          failed.push({ id, number: id, reason: e?.message || 'PDF error' })
        }
      }

      // Always add a manifest with the list of
      // included invoices. Tier 139: enrich the
      // manifest with invoice number + issue date +
      // customer name (was just the id list before,
      // which is useless to a Steuerberater who
      // doesn't speak UUID). We re-fetch a small
      // per-invoice projection in one query to
      // avoid N+1 — the bulk-download is the one
      // path that does N lookups for N invoices
      // already (one PDF per invoice), so an extra
      // one Prisma query for the manifest is
      // negligible.
      const meta = await this.prisma.invoice.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          invoiceNumber: true,
          issueDate: true,
          total: true,
          currency: true,
          customer: { select: { name: true, customerNumber: true } },
        },
      })
      const metaById = new Map(meta.map((m: any) => [m.id, m]))
      const manifestLines: string[] = [
        `# Rechnungs-Bündel`,
        `# Erstellt am: ${new Date().toISOString()}`,
        `# Format: ${format.toUpperCase()}`,
        `# Enthalten: ${okCount} / Angefragt: ${ids.length}`,
        ``,
      ]
      for (const id of ids) {
        const m: any = metaById.get(id)
        if (m) {
          const date = m.issueDate
            ? new Date(m.issueDate).toISOString().slice(0, 10)
            : '—'
          const total = `${Number(m.total || 0).toFixed(2)} ${m.currency || 'EUR'}`
          const cust = m.customer?.name || '—'
          const custNo = m.customer?.customerNumber
            ? ` (${m.customer.customerNumber})`
            : ''
          manifestLines.push(
            `  ${m.invoiceNumber}  ${date}  ${total}  ${cust}${custNo}`,
          )
        } else {
          manifestLines.push(`  ${id}  —  —  (FEHLER: nicht enthalten)`)
        }
      }
      zip.append(manifestLines.join('\n'), { name: '_manifest.txt' })

      if (failed.length > 0) {
        const errorReport =
          `# Fehler beim Bündeln\n` +
          failed.map((f) => `- ${f.number}: ${f.reason}`).join('\n')
        zip.append(errorReport, { name: '_errors.txt' })
      }

      await zip.finalize()
    } catch (error: any) {
      console.error('Bulk download error:', error)
      // After headers are sent we can't change status. If we still can,
      // surface the error as JSON.
      if (!res.headersSent) {
        res.status(500).json({ message: error?.message || 'Bulk-Download fehlgeschlagen' })
      } else {
        res.end()
      }
    }
  }

  // CSV export — selects invoices by date range (and optional type/status)
  // and returns a single CSV file. UTF-8 with BOM so Excel auto-detects
  // encoding. Semicolon-separated to play nice with German Excel installs
  // that use comma as decimal separator.
  // Query params: ?companyId=...&dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
  //               &type=INV|CN|PI|RCV&status=draft|sent|paid|overdue|cancelled
  // Requires at least one of dateFrom or dateTo.
  @Get('export/csv')
  @Require('invoice.read')
  async exportCsv(
    @Query('companyId') companyId: string,
    @Query('dateFrom') dateFrom: string,
    @Query('dateTo') dateTo: string,
    @Query('type') type: string,
    @Query('status') status: string,
    @Res() res: Response,
  ) {
    if (!companyId) {
      res.status(400).json({ message: 'companyId ist erforderlich' })
      return
    }
    if (!dateFrom && !dateTo) {
      res.status(400).json({ message: 'dateFrom oder dateTo ist erforderlich' })
      return
    }
    try {
      const rows = await this.invoiceService.findForExport(companyId, {
        dateFrom,
        dateTo,
        type,
        status,
      })
      // RFC 4180-style escaping: wrap fields that contain quotes,
      // commas, or newlines in double quotes; double internal quotes.
      const esc = (v: unknown) => {
        if (v === null || v === undefined) return ''
        const s = String(v)
        return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      const header = [
        'Rechnungsnummer',
        'Typ',
        'Status',
        'Ausstellungsdatum',
        'Fälligkeitsdatum',
        'Kundennummer',
        'Kunde',
        'Kunden-UST-ID',
        'Netto',
        'USt',
        'Gesamt',
        'Währung',
        'Bezug (CN)',
        'Positionen',
        'Betrag bezahlt',
        'Offen',
        'Erstellt am',
        'Aktualisiert am',
      ]
      const lines = rows.map((inv: any) => {
        // Tier 245: Decimal累加 — preserve 4-decimal
        // precision on payment amount sums (CSV export).
        const paid = (inv.payments || []).reduce(
          (s: any, p: any) => s.plus(new Prisma.Decimal(p.amount ?? 0)),
          new Prisma.Decimal(0),
        ).toNumber()
        const total = Number(inv.total || 0)
        return [
          inv.invoiceNumber,
          inv.type,
          inv.status,
          inv.issueDate ? new Date(inv.issueDate).toISOString().slice(0, 10) : '',
          inv.dueDate ? new Date(inv.dueDate).toISOString().slice(0, 10) : '',
          inv.customer?.customerNumber || '',
          inv.customer?.name || '',
          inv.customer?.vatId || '',
          // Per-line money values are stored on `items[].netAmount /
          // items[].vatAmount`, but the invoice-level columns in the
          // Prisma model are `subtotal` and `totalVat`. The previous
          // code read `inv.netAmount` / `inv.vatAmount` (always
          // undefined) and the CSV always exported 0.00 for Netto and
          // USt. Use the correct column names here.
          Number(inv.subtotal || 0).toFixed(2),
          Number(inv.totalVat || 0).toFixed(2),
          total.toFixed(2),
          inv.currency || 'EUR',
          inv.referenceInvoice?.invoiceNumber || '',
          (inv.items || []).length,
          paid.toFixed(2),
          Math.max(0, total - paid).toFixed(2),
          inv.createdAt ? new Date(inv.createdAt).toISOString() : '',
          inv.updatedAt ? new Date(inv.updatedAt).toISOString() : '',
        ].map(esc).join(';')
      })
      const csv = '\uFEFF' + [header.map(esc).join(';'), ...lines].join('\n')
      const fromPart = dateFrom || 'alle'
      const toPart = dateTo || 'alle'
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Rechnungen_${fromPart}_${toPart}.csv"`,
      })
      res.send(csv)
    } catch (error: any) {
      console.error('CSV export error:', error)
      res.status(500).json({ message: error?.message || 'CSV-Export fehlgeschlagen' })
    }
  }

  // IMPORTANT: /pdf route must come BEFORE /:id to avoid "pdf" being captured as id
  //
  // Tier 60: default format is now ZUGFeRD 2.1 (Factur-X
  // / EN16931) — a PDF/A-3 with an embedded CrossIndustryInvoice
  // XML that ERP systems (Lexware, SevDesk, Datev, etc.) can
  // parse. The visual layout is identical to the plain PDF,
  // so humans reading the PDF see no difference. EU B2B
  // E-Invoice compliance (Wachstumschancengesetz §3b UStG,
  // effective 2025-01-01) requires the recipient to accept
  // an E-Invoice in this format — plain PDF is no longer
  // sufficient for B2B.
  //
  // Query params:
  //   ?format=zugferd  (default) — PDF/A-3 with embedded
  //                            Factur-X XML
  //   ?format=pdf       — visual-only PDF, no XML attachment.
  //                       Use this when the recipient explicitly
  //                       asks for a "printable" PDF (rare in
  //                       B2B but common in some legacy flows)
  //   ?format=xrechnung — alias for the XRechnung XML endpoint
  //                       (see :id/xrechnung). Returns the raw
  //                       XML, not a PDF.
  //
  // Tier 225: standalone GiroCode (EPC QR) PNG
  // download. Sibling to :id/pdf but returns ONLY the
  // QR code as a 566×566 PNG (2cm at 72dpi × 4x
  // oversample, scannable from any monitor / printed
  // envelope). The QR encodes the same EPC069-12 v2
  // payload the PDF footer embeds, so a customer who
  // can't print the invoice can still pay via the
  // German banking apps by downloading this single
  // image.
  //
  // Route must come BEFORE :id/pdf to avoid `:id`
  // greedy-matching "abc-girocode.png" as the id.
  // (PDFKit's regex routing also has the same problem
  // — we put the more specific path first by
  // convention.)
  @Get(':id/girocode.png')
  @Header('Content-Type', 'image/png')
  @Header(
    'Content-Disposition',
    'attachment; filename="girocode.png"', // overridden below with the actual invoice number
  )
  @Require('invoice.read')
  async downloadGirocodePng(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Res() res: Response,
  ) {
    try {
      if (!companyId) {
        return res.status(400).json({ message: 'companyId ist erforderlich' })
      }
      const invoice = await this.invoiceService.findOne(id, companyId)
      const company = await this.prisma.company.findUnique({ where: { id: companyId } })
      if (!invoice) {
        return res.status(404).json({ message: 'Rechnung nicht gefunden' })
      }
      if (!company) {
        return res.status(404).json({ message: 'Unternehmen nicht gefunden' })
      }
      // Reuse the same GiroCode payload builder the
      // PDF embeds — single source of truth. Falls
      // through to 404 when the company has no IBAN
      // (no scannable code to give the customer).
      const qrPayload = buildEpcQrPayload(company as any, invoice as any)
      if (!qrPayload) {
        return res.status(404).json({
          message: 'Keine IBAN hinterlegt — GiroCode nicht verfügbar',
        })
      }
      // 566px = 2cm at 72dpi × 4x oversample.
      // PDFKit's :id/pdf uses 360 (4x of 90pt), but
      // the standalone download is meant to be
      // viewed / printed at higher res, so we go
      // bigger — 566px is a common QR size for
      // "scan from monitor" workflows and stays
      // well under 5KB.
      const png = await QRCode.toBuffer(qrPayload, {
        errorCorrectionLevel: 'M',
        type: 'png',
        margin: 2,
        width: 566,
      })
      // Override the static @Header with a
      // per-invoice filename so the browser saves
      // "INV-2026-006285_GiroCode.png" rather
      // than the generic "girocode.png". The
      // @Header decorator sets the header on
      // route match; res.setHeader here wins.
      const safeNum = String(invoice.invoiceNumber || 'invoice').replace(/[^A-Za-z0-9._-]/g, '_')
      res.setHeader('Content-Disposition', `attachment; filename="${safeNum}_GiroCode.png"`)
      res.setHeader('Content-Length', String(png.length))
      res.send(png)
    } catch (err: any) {
      // Cross-tenant invoice id returns 404 (security
      // through obscurity — same convention as the
      // other invoice endpoints).
      if (err?.status === 404 || err?.code === 'P2025') {
        return res.status(404).json({ message: 'Rechnung nicht gefunden' })
      }
      throw err
    }
  }

  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  @Require('invoice.read')
  async downloadPdf(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('format') formatParam: string | undefined,
    // Tier 165: ?sign=false returns an unsigned
    // PDF (useful for e2e tests that want to
    // verify the raw generateInvoicePDF output
    // without the signing overhead, and for
    // the rare case where the recipient asks
    // for a "plain" PDF). Default is sign=true
    // because every invoice we ship should
    // carry a signature (GoBD § 146 AO).
    @Query('sign') signParam: string | undefined,
    // Tier 165: ?meta=true returns JSON with
    // just the signature metadata (signed,
    // signerCN, fingerprint) instead of a PDF
    // body. Used by the invoice-detail page to
    // pre-fill the "Signatur-Status" card
    // without downloading the full PDF.
    @Query('meta') metaParam: string | undefined,
    @Res() res: Response,
  ) {
    try {
      // Tier 372: a missing ?companyId= used to reach invoiceService.findOne()
      // as `undefined`, where Prisma threw a validation error and this route
      // answered 500 "PDF generation failed". The auth guard reads the
      // x-company-id HEADER, so such a request passes auth and only fails
      // later. It is a client error: say so. (The catch below rethrows
      // HttpExceptions, so this stays a 400.)
      if (!companyId) {
        throw new BadRequestException('companyId ist erforderlich')
      }
      // Tier 165: ?meta=true short-circuits
      // before PDF generation. We still
      // resolve the company + cert so the
      // response reflects "what WOULD happen
      // on download" — but we don't actually
      // sign a PDF. This is cheap (~50ms
      // for a Prisma read + cert lookup)
      // and avoids the browser having to
      // fetch + abort the PDF body to read
      // the X-PDF-* headers.
      if (metaParam === 'true') {
        const signing = await this.signingService.getCertInfo(companyId)
        res.json({
          signed: signParam !== 'false',
          signerCN: signing.commonName,
          fingerprint: signing.fingerprint,
        })
        return
      }
      // XRechnung XML is a separate MIME type — short-circuit
      // before any PDF generation logic so the response
      // headers are correct. The legacy `/invoices/:id/xrechnung`
      // route is kept for backwards-compat; this alias lets the
      // invoice-detail UI use a single "E-Invoice" dropdown
      // that lists "ZUGFeRD" / "XRechnung" / "Plain PDF".
      if (formatParam === 'xrechnung' || formatParam === 'xml') {
        return this.streamXRechnung(id, companyId, res)
      }
      const format: 'zugferd' | 'pdf' =
        formatParam === 'pdf' || formatParam === 'visual' ? 'pdf' : 'zugferd'

      const invoice = await this.invoiceService.findOne(id, companyId);
      const company = await this.prisma.company.findUnique({ where: { id: companyId } });

      // Pass the FULL company object to generateInvoicePDF. The
      // PDF generator reads many fields off the company object
      // (registerEntry, managingDirector, otherInfo, fax,
      // website, etc.) for the right-side Impressum block and
      // the letterhead contact line. Earlier versions of this
      // controller only forwarded a 6-field subset (name,
      // address, vatId, taxId, bankInfo, logoPath), which made
      // the Impressum block render as empty (the if-conditions
      // in the PDF service short-circuited because the fields
      // were undefined). User reported the right-footer
      // Impressum was missing in downloaded PDFs.
      const templateConfig = await this.resolveTemplateConfig(
        companyId,
        invoice.templateType || 'standard',
        (invoice as any).templateId,
      )
      const companyCtx = {
        name: company?.name || '',
        legalName: company?.legalName || undefined,
        address: company?.address || {},
        vatId: company?.vatId || undefined,
        taxId: company?.taxId || undefined,
        email: company?.email || undefined,
        phone: company?.phone || undefined,
        fax: company?.fax || undefined,
        website: company?.website || undefined,
        registerEntry: company?.registerEntry || undefined,
        managingDirector: company?.managingDirector || undefined,
        otherInfo: company?.otherInfo || undefined,
        bankInfo: company?.bankInfo || undefined,
        logoPath: company?.logoPath || undefined,
        templateConfig,
      } as any

      // Tier 60: ZUGFeRD is the default. The embedded XML
      // carries the machine-readable invoice data (per EN16931);
      // the visual PDF is the same as the legacy plain-PDF
      // render. The embedded step is ~80-120ms on a typical
      // workstation — small enough that we don't need a
      // separate cached /zugferd endpoint.
      //
      // Polish #10 fix: pass `templateConfig` as the 4th
      // argument to generateInvoicePDF. The PDF generator
      // reads the per-template fontFamily / primaryColor /
      // layoutDensity from THIS argument, not from
      // companyCtx.templateConfig. Without the 4th arg,
      // the PDF always uses the Helvetica default + black
      // text regardless of the InvoiceTemplate config —
      // 34-template-applied.sh asserts on the rendered
      // font and color, so this was a real bug.
      const pdfBuffer = format === 'zugferd'
        ? await generateZUGFeRD(invoice as any, companyCtx as any, { templateConfig: templateConfig as any })
        : await generateInvoicePDF(invoice as any, companyCtx as any, invoice.templateType || 'standard', templateConfig as any)

      // Auto-save PDF to local storage. The path is the
      // visual PDF (same content whether ZUGFeRD or plain)
      // so the existing storage layer doesn't need a new
      // column. The ZUGFeRD XML is embedded INTO the saved
      // PDF — reopening it shows the XML attachment, so
      // downstream re-downloads are still E-Invoice compliant.
      if (!invoice.pdfPath) {
        try {
          const savedFile = await this.storageService.saveInvoicePdf(
            pdfBuffer,
            invoice.invoiceNumber,
            companyId,
          );
          // Update invoice with PDF path
          await this.prisma.invoice.update({
            where: { id: id },
            data: { pdfPath: savedFile.path },
          });
        } catch (saveError) {
          console.error('Failed to save PDF to storage:', saveError);
          // Continue anyway - PDF is still being served
        }
      }

      // Filename hints at the format so a Steuerberater
      // dragging the file into their archive can see at
      // a glance whether it carries the XML. The `_einvoice`
      // suffix is the de-facto convention in the EU B2B
      // space (Lexware and SevDesk both use it).
      let fname = format === 'zugferd'
        ? `${invoice.invoiceNumber}_einvoice.pdf`
        : `${invoice.invoiceNumber}.pdf`

      // Tier 165: optionally sign the PDF. The
      // signed output is the same PDF + a PKCS#7
      // signature appended in a new /ByteRange +
      // /Contents dictionary; Adobe Reader shows
      // the signature badge in the panel.
      //
      // We never let a signing failure block the
      // download. If signPdf throws, the user
      // still gets the unsigned PDF — the
      // X-PDF-Signed header is set to "false"
      // and the e2e tests check that the
      // download succeeded.
      let signedBuffer: Buffer = pdfBuffer
      let signed = false
      let signerCommonName: string | null = null
      let signerFingerprint: string | null = null
      const shouldSign = signParam !== 'false'
      if (shouldSign) {
        try {
          signedBuffer = await this.signingService.signPdf(
            companyId,
            pdfBuffer,
          )
          // Refresh the cert info AFTER signing so
          // the headers reflect the cert that was
          // actually used (the cert may have been
          // auto-generated on first call inside
          // signPdf → getOrCreate).
          const cert = await this.signingService.getCertInfo(
            companyId,
          )
          signed = true
          signerCommonName = cert.commonName
          signerFingerprint = cert.fingerprint
          // PAdES-style filename suffix so the
          // recipient can see at-a-glance the
          // PDF carries a signature. Adobe Reader
          // also reads the /Contents dict and
          // shows the badge independently.
          fname = fname.replace(/\.pdf$/, '_signed.pdf')
        } catch (signErr) {
          // Log + continue. The user gets an
          // unsigned PDF; the headers reflect
          // that. Same fail-soft pattern we use
          // for the storage save above.
          console.error(
            'PDF signing failed, returning unsigned:',
            signErr,
          )
        }
      }

      // Tier 165: PAdES signature metadata
      // headers. The browser can't read the
      // PKCS#7 inside the PDF directly, so we
      // surface the cert CN + fingerprint as
      // response headers. The frontend reads
      // these via HEAD and shows the "Signiert
      // von X (FP: AA:BB:...)" card.
      const headers: Record<string, string> = {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fname}"`,
        'Content-Length': String(signedBuffer.length),
        'X-PDF-Signed': signed ? 'true' : 'false',
      }
      if (signed) {
        headers['X-PDF-Signer-CN'] = signerCommonName || ''
        headers['X-PDF-Fingerprint'] = signerFingerprint || ''
      }
      res.set(headers)
      res.end(signedBuffer)
    } catch (error) {
      // Tier 361: findOne() throws NotFoundException for an unknown or
      // foreign invoice id, and this catch turned it into
      // 500 "PDF generation failed" (e2e/154 hit it). Let HTTP exceptions
      // through to the exception filter; only real generation failures are
      // a 500.
      if (error instanceof HttpException) throw error;
      console.error('PDF generation error:', error);
      res.status(500).json({ error: 'PDF generation failed' });
    }
  }

  /**
   * Tier 60: XRechnung XML serializer. Sibling of the legacy
   * `/invoices/:id/xrechnung` route — exposed via
   * `/invoices/:id/pdf?format=xrechnung` for the "one endpoint
   * for everything" convention that the invoice-detail UI
   * uses. The response is application/xml, not application/pdf.
   */
  private async streamXRechnung(
    id: string,
    companyId: string,
    res: Response,
  ) {
    try {
      const invoice = await this.invoiceService.findOne(id, companyId)
      const company = await this.prisma.company.findUnique({ where: { id: companyId } })
      if (!company) {
        res.status(404).json({ error: 'Company not found' })
        return
      }
      // Tier 115: pull the B2G Leitweg-ID from
      // settings.leitwegId. Stored in JSONB settings rather
      // than as a top-level column (same convention as
      // rechtsform, sepaCreditorIdentifier, etc.).
      const companyWithLeitweg = {
        ...company,
        leitwegId: (company.settings as any)?.leitwegId || null,
      } as any
      const xrechnungData = transformToXRechnungData(invoice, companyWithLeitweg)
      const xmlContent = generateXRechnung(xrechnungData)
      const buffer = Buffer.from(xmlContent, 'utf-8')
      res.set({
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}_xrechnung.xml"`,
        'Content-Length': buffer.length,
      })
      res.end(buffer)
    } catch (err) {
      // Tier 378: rethrow NotFound etc. (as Tier 361 did for the PDF) —
      // an unknown or foreign invoice id answered 500.
      if (err instanceof HttpException) throw err
      console.error('XRechnung generation error:', err)
      res.status(500).json({ error: 'XRechnung generation failed' })
    }
  }

  // XRechnung download endpoint
  @Get(':id/xrechnung')
  @Require('invoice.read')
  @Header('Content-Type', 'application/xml')
  async downloadXRechnung(@Param('id') id: string, @Query('companyId') companyId: string, @Res() res: Response) {
    try {
      const invoice = await this.invoiceService.findOne(id, companyId);
      const company = await this.prisma.company.findUnique({ where: { id: companyId } });

      if (!company) {
        res.status(404).json({ error: 'Company not found' });
        return;
      }

      const companyWithLeitweg = {
        ...company,
        leitwegId: (company.settings as any)?.leitwegId || null,
      } as any;
      const xrechnungData = transformToXRechnungData(invoice, companyWithLeitweg);
      const xmlContent = generateXRechnung(xrechnungData);

      const buffer = Buffer.from(xmlContent, 'utf-8');

      res.set({
        'Content-Type': 'application/xml',
        'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}_xrechnung.xml"`,
        'Content-Length': buffer.length,
      });
      res.end(buffer);
    } catch (error) {
      if (error instanceof HttpException) throw error; // Tier 378, see above
      console.error('XRechnung generation error:', error);
      res.status(500).json({ error: 'XRechnung generation failed' });
    }
  }

  /**
   * Tier 115/116: XRechnung validation. Two engines:
   *   - ?engine=basic (default): in-process EN 16931 BR-*
   *     check (Tier 115). Fast, no Java/JAR required.
   *   - ?engine=kosit: full KoSIT Validator 1.6.2 (Tier 116)
   *     with 150+ rules including all BR-*, BR-CO-*, BR-DEC-*
   *     and BR-S-*. Falls back to basic if KoSIT is
   *     unavailable (returns the basic result + a note).
   */
  @Get(':id/xrechnung/validate')
  @Require('invoice.read')
  async validateInvoiceXRechnung(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('engine') engineRaw?: string,
  ) {
    const invoice = await this.invoiceService.findOne(id, companyId)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company) {
      throw new BadRequestException('Company not found')
    }
    const companyWithLeitweg = {
      ...company,
      leitwegId: (company.settings as any)?.leitwegId || null,
    } as any
    const engine = (engineRaw || 'basic').toLowerCase()
    if (engine !== 'basic' && engine !== 'kosit') {
      throw new BadRequestException(
        `Invalid engine "${engineRaw}". Use "basic" (default, fast in-process BR-* check) or "kosit" (full KoSIT JAR validation).`,
      )
    }

    if (engine === 'kosit') {
      // Tier 116: call the KoSIT Validator JAR. Falls back
      // to basic with a note if the JAR / JDK is missing.
      const xrechnungData = transformToXRechnungData(invoice, companyWithLeitweg)
      const xml = generateXRechnung(xrechnungData)
      try {
        return await validateXRechnungWithKoSIT(xml)
      } catch (err: any) {
        if (err instanceof KoSITValidatorUnavailableError) {
          const basic = validateXRechnung(xrechnungData)
          return {
            ...basic,
            engine: 'kosit-unavailable' as const,
            warnings: [
              ...basic.warnings,
              {
                rule: 'BT-ENGINE',
                message: `KoSIT Validator not available: ${err.message}. Falling back to in-process BR-* check.`,
              },
            ],
          }
        }
        throw err
      }
    }
    // engine=basic (default) — fast in-process BR-* check
    const xrechnungData = transformToXRechnungData(invoice, companyWithLeitweg)
    return validateXRechnung(xrechnungData)
  }

  // ZUGFeRD download endpoint
  @Get(':id/zugferd')
  @Require('invoice.read')
  @Header('Content-Type', 'application/pdf')
  async downloadZUGFeRD(@Param('id') id: string, @Query('companyId') companyId: string, @Res() res: Response) {
    try {
      const invoice = await this.invoiceService.findOne(id, companyId);
      const company = await this.prisma.company.findUnique({ where: { id: companyId } });

      if (!company) {
        res.status(404).json({ error: 'Company not found' });
        return;
      }

      const pdfBuffer = await generateZUGFeRD(invoice, {
        name: company.name,
        legalName: company.legalName || undefined,
        address: company.address || {},
        vatId: company.vatId || undefined,
        taxId: company.taxId || undefined,
        email: company.email || undefined,
        phone: company.phone || undefined,
        fax: company.fax || undefined,
        website: company.website || undefined,
        registerEntry: company.registerEntry || undefined,
        managingDirector: company.managingDirector || undefined,
        otherInfo: company.otherInfo || undefined,
        bankInfo: company.bankInfo || undefined,
        logoPath: company.logoPath || undefined,
      }, { version: '2.1', conformanceLevel: 'EN16931' });

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}_ZUGFeRD.pdf"`,
        'Content-Length': pdfBuffer.length,
      });
      res.end(pdfBuffer);
    } catch (error) {
      if (error instanceof HttpException) throw error; // Tier 378, see above
      console.error('ZUGFeRD generation error:', error);
      res.status(500).json({ error: 'ZUGFeRD generation failed' });
    }
  }

  /**
   * Tier 150: duplicate detection.
   *
   * When the admin is creating a new invoice,
   * we look for similar invoices in the
   * recent past (same customer + same total +
   * nearby issueDate). If we find any, we
   * surface them so the admin can confirm
   * "no, this is a new one" before clicking
   * Submit.
   *
   * Matching rules:
   *   - Same companyId (tenant isolation)
   *   - Same customerId
   *   - Amount within 0.01 EUR (handles float
   *     rounding)
   *   - issueDate within ±7 days of the input
   *   - status NOT 'cancelled' (cancelled
   *     invoices are noise — they were
   *     cancelled for a reason)
   *   - type IN ('INV','PI') — credit notes
   *     and receipts are different documents
   *
   * DECLARED BEFORE `:id` per the NestJS
   * route-order gotcha (first match wins;
   * `:id` would otherwise swallow
   * "duplicate-check").
   */
  @Get('duplicate-check')
  @Require('invoice.read')
  async duplicateCheck(
    @Query('companyId') companyId: string,
    @Query('customerId') customerId: string,
    @Query('amount') amountStr: string,
    @Query('issueDate') issueDateStr: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!customerId) {
      throw new BadRequestException('customerId is required')
    }
    const amount = parseFloat(amountStr)
    if (!amount || isNaN(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number')
    }
    if (!issueDateStr) {
      throw new BadRequestException('issueDate is required (ISO 8601)')
    }
    const issueDate = new Date(issueDateStr)
    if (isNaN(issueDate.getTime())) {
      throw new BadRequestException('issueDate is invalid')
    }
    // ±7 day window
    const from = new Date(issueDate)
    from.setDate(from.getDate() - 7)
    const to = new Date(issueDate)
    to.setDate(to.getDate() + 7)
    return this.invoiceService.findDuplicates(
      companyId,
      customerId,
      amount,
      from,
      to,
    )
  }

  @Get(':id')
  @Require('invoice.read')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    return this.invoiceService.findOne(id, companyId);
  }

  @Post()
  @Require('invoice.create')
  async create(@Query('companyId') companyId: string, @Body() dto: CreateInvoiceDto) {
    return this.invoiceService.create(companyId, dto);
  }

  @Put(':id')
  @Require('invoice.update')
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() dto: UpdateInvoiceDto,
  ) {
    return this.invoiceService.update(id, companyId, dto);
  }

  // Hard delete: invoice + items + payments, all inside a transaction.
  // Only invoices from the SAME day are deletable — past-day invoices
  // are considered "frozen" because the customer may already have
  // received the PDF / email; a same-day delete is treated as a typo
  // correction (the user hadn't sent it out yet).
  // The earlier pseudo-delete (status='cancelled') is kept as a
  // soft-cancel option via PUT /:id/status; this is the real one.
  @Delete(':id')
  @Require('invoice.delete')
  async delete(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) {
      return { error: 'companyId ist erforderlich' }
    }
    const result = await this.invoiceService.delete(id, companyId)
    return { success: true, deleted: result }
  }

  @Put(':id/status')
  @Require('invoice.update')
  async updateStatus(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: UpdateInvoiceStatusDto,
  ) {
    return this.invoiceService.updateStatus(id, companyId, body.status);
  }

  @Get(':id/email-data')
  @Require('invoice.send')
  async getEmailData(@Param('id') id: string, @Query('companyId') companyId: string) {
    const invoice = await this.invoiceService.findOne(id, companyId);
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const customer = invoice.customer;

    // Build email content in German
    const recipientEmail = (customer?.contact as any)?.email || '';
    const recipientName = customer?.name || '';
    const invoiceNumber = invoice.invoiceNumber;
    const totalAmount = parseFloat(invoice.total.toString()).toFixed(2);

    const subject = `Rechnung ${invoiceNumber}`;
    const body = `Sehr geehrte/r Herr/Frau ${recipientName},\n\nanbei erhalten Sie die Rechnung ${invoiceNumber} über EUR ${totalAmount}.\n\nBitte begleichen Sie den Betrag bis zum Fälligkeitsdatum.\n\nMit freundlichen Grüßen\n${company?.name || ''}`;

    return {
      recipientEmail,
      recipientName,
      subject,
      body,
      pdfUrl: `/api/v1/invoices/${id}/pdf?companyId=${companyId}`,
      invoiceNumber,
      totalAmount,
    };
  }

  // Send invoice via email (multi-locale template + PDF attachment + optional
  // user override for recipient / CC / subject / body).
  //
  // Request body (all fields optional except those noted):
  //   language:        'de' | 'en' | 'zh' — locale for the default template
  //                    (overridable by overrideSubject / overrideBody)
  //   overrideTo:      string  — replaces customer.contact.email
  //                    (used by the form-modal to send to a different
  //                    address, e.g. the customer's accounting dept)
  //   overrideSubject: string  — replaces the rendered subject entirely
  //   overrideBody:    string  — replaces the rendered body entirely
  //   ccEmail:         string  — single CC recipient (sender's own email
  //                    for the "send me a copy" checkbox)
  //   extraCc:         string[] — additional CC addresses
  //   createdById:     string  — the User who initiated the send, recorded
  //                    in EmailSend.createdById for audit
  //   salutation:      string  — explicitly sets the salutation (e.g. the
  //                    user picked "Sehr geehrte Frau" in the form).
  //                    If unset, defaultSalutationFor() is used.
  //
  // The user's override values are sanitised lightly (trim, length cap)
  // but the body is NOT HTML — it's plain text for the email body.
  // The customer name IS HTML-escaped by the template (defence in
  // depth against a malicious customer name in the DB).
  @Post(':id/send-email')
  @Require('invoice.send')
  async sendInvoiceEmail(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: SendInvoiceEmailDto,
  ) {
    // Tier 129: the actual email workflow now lives in
    // InvoiceEmailService so the recurring scheduler can
    // call it without going through the HTTP layer.
    // The controller still owns the route + permission
    // check + request body shape.
    return this.invoiceEmailService.sendInvoiceByEmail(id, companyId, {
      ...body,
      source: 'manual',
    });
  }

  /**
   * Tier 32 — bulk email send.
   *
   * The user picks N invoices from the list and clicks
   * "Alle ausgewählten senden". We call sendInvoiceEmail
   * for each one, with a small concurrency limit so the
   * SMTP transporter doesn't choke on 100 parallel
   * connections.
   *
   * Body shape mirrors sendInvoiceEmail + the bulk shape:
   *   {
   *     invoiceIds: string[],   // required, max 100
   *     language?: 'de'|'en'|'zh',
   *     overrideSubject?: string,
   *     overrideBody?: string,
   *     ccEmail?: string,
   *     extraCc?: string[],
   *     createdById?: string,
   *     dryRun?: boolean,       // validate but don't actually send
   *     concurrency?: number,   // default 5, max 10
   *   }
   *
   * Returns:
   *   {
   *     total: number,
   *     succeeded: number,
   *     failed: number,
   *     dryRun: boolean,
   *     results: Array<{
   *       invoiceId: string,
   *       invoiceNumber?: string,
   *       ok: boolean,
   *       recipient?: string,
   *       error?: string,
   *     }>,
   *   }
   *
   * Each failure is captured in `results` — the call as
   * a whole returns 200 even when some sends fail. This
   * matches the convention from bulk-download: partial
   * success is normal, the caller walks `results` to
   * see which rows need a retry.
   */
  @Post('bulk-send-by-filter')
  @Require('invoice.send')
  // Bulk send-by-filter: server picks invoices by
  // date/status + sends email to each. Can fan out
  // to hundreds of emails. Tight local limit
  // (overrides the global 600/60s): 5 per 5 min
  // per IP. The button is human-driven; 5 per 5 min
  // is plenty.
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  async bulkSendByFilter(
    @Query('companyId') companyId: string,
    @Body() body: {
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      status?: string;
      language?: 'de' | 'en' | 'zh';
      overrideSubject?: string;
      overrideBody?: string;
      concurrency?: number;
      dryRun?: boolean;
    },
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!body?.dateFrom && !body?.dateTo) {
      throw new BadRequestException(
        'dateFrom oder dateTo ist erforderlich (gleiche Logik wie der CSV-Export)',
      )
    }
    // 1. Resolve every invoice matching the date
    //    range (+ type/status filter) via the same
    //    helper the CSV/ZIP exports use. This keeps
    //    "all overdue in Q3" consistent across
    //    every batch workflow — one filter, three
    //    output formats (CSV / ZIP / emails).
    const rows = await this.invoiceService.findForExport(companyId, {
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      type: body.type,
      status: body.status,
    })
    if (rows.length === 0) {
      return {
        total: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        results: [],
        message: 'Keine Rechnungen im Zeitraum gefunden',
      }
    }
    if (rows.length > 100) {
      throw new BadRequestException(
        `Maximal 100 Rechnungen pro Anfrage (gefunden: ${rows.length})`,
      )
    }
    // 2. Delegate to the existing bulk-send-email
    //    worker pool. We pass the full filter
    //    pipeline through (override subject/body,
    //    language, dryRun) so a single button
    //    can power a monthly reminder batch
    //    ("Alle überfälligen im Oktober senden")
    //    with a custom subject, or just default
    //    to the per-invoice template.
    return this.bulkSendEmails(companyId, {
      invoiceIds: rows.map((r: any) => r.id),
      language: body.language,
      overrideSubject: body.overrideSubject,
      overrideBody: body.overrideBody,
      concurrency: body.concurrency,
      dryRun: body.dryRun,
    })
  }

  @Post('bulk-send-email')
  @Require('invoice.send')
  // Bulk send-email (explicit invoiceIds[]): can fan
  // out to hundreds of emails. Tier 251 bumped the
  // limit from 5 → 15 per 5 min per IP. The e2e suite
  // fires 6+ calls in quick succession across
  // bulk-mail / bulk-mahnung / cron history / etc.
  // 15 still throttles a real misbehaving script
  // (~1 hit every 20s) and matches the operator
  // ceiling.
  @Throttle({ default: { limit: 15, ttl: 300_000 } })
  async bulkSendEmails(
    @Query('companyId') companyId: string,
    @Body() body: BulkSendInvoiceEmailDto,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich');
    }
    const ids = Array.isArray(body?.invoiceIds) ? body.invoiceIds.filter((x) => typeof x === 'string' && x) : [];
    if (ids.length === 0) {
      throw new BadRequestException('invoiceIds ist erforderlich');
    }
    if (ids.length > 100) {
      throw new BadRequestException('Maximal 100 Rechnungen pro Anfrage');
    }

    // Concurrency cap. The SMTP transporter opens one
    // connection per send; we don't want 100 sockets
    // going out at once.
    const concurrency = Math.min(
      Math.max(Number(body?.concurrency ?? 5), 1),
      10,
    );
    const dryRun = !!body?.dryRun;

    type Row = {
      invoiceId: string;
      invoiceNumber?: string;
      ok: boolean;
      recipient?: string;
      error?: string;
    };
    const results: Row[] = [];

    // Simple worker-pool: process N at a time.
    // Avoids pulling in a p-limit dep just for this.
    const queue = ids.slice();
    const workers: Promise<void>[] = [];
    const buildCommonBody = () => ({
      ccEmail: body?.ccEmail,
      extraCc: body?.extraCc,
      overrideTo: undefined as string | undefined,
      overrideSubject: body?.overrideSubject,
      overrideBody: body?.overrideBody,
      language: body?.language,
      salutation: undefined as string | undefined,
      createdById: body?.createdById,
    });

    for (let w = 0; w < concurrency; w++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const invoiceId = queue.shift()!;
            if (dryRun) {
              // Dry-run: load the invoice, validate the
              // recipient is present and well-formed, but
              // don't render the PDF or hit SMTP.
              try {
                const invoice = await this.invoiceService.findOne(invoiceId, companyId);
                const customer = invoice.customer;
                const defaultRecipient = (customer?.contact as any)?.email;
                const recipient = (defaultRecipient || '').trim();
                if (!recipient) {
                  results.push({
                    invoiceId,
                    invoiceNumber: invoice.invoiceNumber,
                    ok: false,
                    error: 'Kunde hat keine E-Mail-Adresse hinterlegt',
                  });
                } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
                  results.push({
                    invoiceId,
                    invoiceNumber: invoice.invoiceNumber,
                    ok: false,
                    error: `Ungültige Empfänger-E-Mail: ${recipient}`,
                  });
                } else {
                  results.push({
                    invoiceId,
                    invoiceNumber: invoice.invoiceNumber,
                    ok: true,
                    recipient,
                  });
                }
              } catch (e: any) {
                results.push({
                  invoiceId,
                  ok: false,
                  error: e?.message || 'Unbekannter Fehler',
                });
              }
            } else {
              try {
                const r = await this.sendInvoiceEmail(
                  invoiceId,
                  companyId,
                  buildCommonBody(),
                );
                results.push({
                  invoiceId,
                  invoiceNumber: r?.subject?.includes?.('RG-')
                    ? undefined
                    : undefined,
                  ok: true,
                  recipient: r?.recipient,
                });
              } catch (e: any) {
                results.push({
                  invoiceId,
                  ok: false,
                  error: e?.message || 'Unbekannter Fehler',
                });
              }
            }
          }
        })(),
      );
    }
    await Promise.all(workers);

    // Stable order: re-sort by the original invoiceIds
    // input so the UI can map rows 1:1.
    const byId = new Map(results.map((r) => [r.invoiceId, r]));
    const ordered: Row[] = ids.map((id) => byId.get(id) || { invoiceId: id, ok: false, error: 'No result (worker exited early)' });
    const succeeded = ordered.filter((r) => r.ok).length;
    const failed = ordered.length - succeeded;
    return {
      total: ordered.length,
      succeeded,
      failed,
      dryRun,
      results: ordered,
    };
  }

  // ─── Payments ──────────────────────────────────────────────────────
  // List all payments recorded against an invoice.
  @Get(':id/payments')

  // ─── Payments ──────────────────────────────────────────────────────
  // List all payments recorded against an invoice.
  // (The duplicate-check route was moved above to
  //  escape the `:id` greedy match.)
  @Require('invoice.read')
  async listPayments(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    return this.paymentService.listForInvoice(id, companyId);
  }

  // Record a new payment. Auto-transitions the invoice to "paid"
  // when the sum of payments covers the invoice total.
  @Post(':id/payments')
  @Require('invoice.update')
  async createPayment(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: CreatePaymentDto,
  ) {
    return this.paymentService.create(id, companyId, {
      amount: Number(body.amount),
      paymentDate: new Date(body.paymentDate),
      paymentMethod: body.paymentMethod,
      reference: body.reference,
      notes: body.notes,
      receiptNumber: body.receiptNumber,
    });
  }

  // Tier 53: Gutschrift (credit note) — generate a CN
  // (Invoice with type='CN') from an existing invoice.
  // The CN carries NEGATIVE line amounts (= the refund)
  // and a referenceInvoiceId back to the original. The
  // original invoice's open balance is automatically
  // reduced by the CN amount — the customer statement
  // shows the original minus the credit.
  //
  // Two shapes are supported:
  //   - Full refund: omit `lines` and `amount`; the
  //     CN mirrors every line of the original with a
  //     negative sign.
  //   - Partial refund: pass `lines: [{...}]` to
  //     override specific lines (each line's
  //     `unitPrice` is the new refund value, sign
  //     doesn't matter — we negate), or pass
  //     `amount: 100` to set a flat total.
  //
  // GoBD: the CN is a NEW invoice (its own number
  // sequence, its own audit trail). We do NOT modify
  // the original.
  @Post(':id/credit-note')
  @Require('invoice.write')
  async createCreditNote(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: CreateCreditNoteDto,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.invoiceService.createCreditNote(
      id,
      companyId,
      body || {},
    )
  }

  // Tier 430: payments the customer reported (portal / payment link). They
  // are booked here once the money has arrived — the customer's click used
  // to book them directly, for any amount.
  @Get(':id/payment-notices')
  @Require('invoice.read')
  async listPaymentNotices(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.paymentService.listNotices(companyId, id);
  }

  @Post(':id/payment-notices/:noticeId/book')
  @Require('invoice.update')
  async bookPaymentNotice(
    @Param('id') id: string,
    @Param('noticeId') noticeId: string,
    @Query('companyId') companyId: string,
    @Body() body: BookPaymentNoticeDto,
    @Req() req: Request,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.paymentService.bookNotice(companyId, id, noticeId, body || {}, (req.headers['x-user-id'] as string) || undefined);
  }

  @Post(':id/payment-notices/:noticeId/dismiss')
  @Require('invoice.update')
  async dismissPaymentNotice(
    @Param('id') id: string,
    @Param('noticeId') noticeId: string,
    @Query('companyId') companyId: string,
    @Req() req: Request,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    return this.paymentService.dismissNotice(companyId, id, noticeId, (req.headers['x-user-id'] as string) || undefined);
  }

  // Remove a recorded payment. Used to fix mistakes. May transition
  // the invoice status back from "paid" to "sent" if the remaining
  // total drops below the invoice total.
  @Delete(':id/payments/:paymentId')
  @Require('accounting.delete')
  async deletePayment(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) throw new Error('companyId is required');
    return this.paymentService.delete(paymentId, companyId);
  }

  /**
   * Tier 7.5: resolve the visual
   * config (primaryColor, font,
   * density, footer text) for an
   * invoice. The render order is:
   *
   * 1. invoice.templateId (explicit)
   * 2. company default template
   * 3. hard-coded preset for
   *    invoice.templateType
   * 4. hard-coded 'standard' preset
   *
   * Returns null if no config was
   * found — the PDF renderer falls
   * back to its built-in hard-coded
   * default in that case (so existing
   * invoices without any template
   * setup continue to render exactly
   * the same).
   *
   * The lookup is wrapped in
   * try/catch because this runs in
   * the hot path of every PDF render;
   * if the templates table is missing
   * (e.g. before prisma db push ran
   * on a fresh checkout) the PDF
   * still works.
   */
  private async resolveTemplateConfig(
    companyId: string,
    templateType: string,
    templateId?: string | null,
  ): Promise<InvoiceRenderConfig | undefined> {
    try {
      const r = await this.templateService.resolveConfig(
        companyId,
        templateType,
        templateId,
      )
      return r.config
    } catch {
      return undefined
    }
  }

  // ---- Tier 138: internal team notes ----
  //
  // List notes for one invoice. Ordered newest
  // first so the latest observation is at the top
  // of the timeline. The PDF / portal / email
  // never include these — they're a pure admin
  // affordance for the Mandant team.
  @Get(':id/internal-notes')
  @Require('invoice.update')
  async listInternalNotes(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.invoiceService.listInternalNotes(companyId, id)
  }

  @Post(':id/internal-notes')
  @Require('invoice.update')
  @HttpCode(200)
  async createInternalNote(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: { body?: string },
    @Req() req: any,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.invoiceService.createInternalNote(companyId, id, body?.body || '', {
      id: req.headers['x-user-id'],
      email: req.headers['x-user-email'],
    })
  }

  @Delete(':id/internal-notes/:noteId')
  @Require('invoice.update')
  @HttpCode(200)
  async deleteInternalNote(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @Req() req: any,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.invoiceService.deleteInternalNote(companyId, id, noteId, {
      id: req.headers['x-user-id'],
      email: req.headers['x-user-email'],
      // The `invoice.update` permission is admin-
      // level in the dev DB (the seeded user is
      // admin). For per-user role checks we'd
      // load the UserCompany.role here; for now
      // we treat any holder of invoice.update as
      // an admin-equivalent for the delete
      // permission. This is fine because the
      // feature is opt-in (only users with
      // invoice.update can hit the endpoint at
      // all) and the notes are not customer-
      // facing — leaking across users inside a
      // company is not a security issue.
      isAdmin: true,
    })
  }

  // ---- Tier 140: invoice-level Belege ----
  //
  // List files attached to this invoice. The
  // upload itself goes through the existing
  // /api/v1/attachments endpoint with
  // entityType='invoice' + entityId=invoiceId
  // (so the storage + OCR + content-hash pipeline
  // is shared with expenses / vouchers). These
  // proxy endpoints just provide a more
  // discoverable URL that the invoice detail
  // page can call without knowing the generic
  // /attachments surface.
  //
  // Download uses the existing
  // /attachments/:id/file endpoint — no proxy
  // needed (the response already sets the right
  // Content-Type + Content-Disposition from the
  // detected MIME type).
  @Get(':id/attachments')
  @Require('invoice.read')
  async listAttachments(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.attachmentsService.listForEntity(companyId, 'invoice', id)
  }

  @Delete(':id/attachments/:attachmentId')
  @Require('invoice.update')
  @HttpCode(200)
  async deleteAttachment(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    // Defense in depth: the attachments service
    // already enforces tenant scoping by companyId,
    // but the URL also includes the parent invoice
    // id. If the attachment isn't actually under
    // this invoice, we'd be deleting something the
    // user didn't expect. The cheap check is one
    // Prisma findFirst with both ids.
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, companyId, entityType: 'invoice', entityId: id },
      select: { id: true },
    })
    if (!att) {
      throw new NotFoundException(
        'Anhang nicht gefunden (gehört nicht zu dieser Rechnung)',
      )
    }
    return this.attachmentsService.delete(companyId, attachmentId)
  }
}