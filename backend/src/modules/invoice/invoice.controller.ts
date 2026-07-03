import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, Res, Header, BadRequestException } from '@nestjs/common';
import { Response } from 'express';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiverLib: any = require('archiver');
const archiver = (format: string, opts?: any) => archiverLib.create(format, opts);
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MailService } from '../mail/mail.service';
import { generateInvoicePDF, InvoiceRenderConfig } from '../../invoices/invoice-pdf.service';
import { generateXRechnung, transformToXRechnungData } from '../../invoices/xrechnung.service';
import { generateZUGFeRD } from '../../invoices/zugferd.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';
import { Auth, Require } from '../../auth/roles.decorator';
import { renderInvoiceEmail, defaultSalutationFor, type EmailLang } from '../mail/templates/invoice-email.template';
import { InvoiceTemplateService } from '../invoice-template/invoice-template.service';

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
  ) {}

  @Get()
  @Require('invoice.read')
  async findAll(
    @Query('companyId') companyId: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.invoiceService.findAll(companyId, {
      status,
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
    const format = body?.format === 'zugferd' ? 'zugferd' : 'pdf'

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

      // Always add a manifest with the list of included invoices.
      const manifest = [
        `# Rechnungs-Bündel`,
        `# Erstellt am: ${new Date().toISOString()}`,
        `# Format: ${format.toUpperCase()}`,
        `# Enthalten: ${okCount} / Angefragt: ${ids.length}`,
        ``,
        ...ids.map((id) => (usedNames.has(id) ? id : `${id} (FEHLER: nicht enthalten)`)),
      ].join('\n')
      zip.append(manifest, { name: '_manifest.txt' })

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
        const paid = (inv.payments || []).reduce(
          (s: number, p: any) => s + Number(p.amount || 0),
          0,
        )
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
      const stamp = new Date().toISOString().slice(0, 10)
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
  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  @Require('invoice.read')
  async downloadPdf(@Param('id') id: string, @Query('companyId') companyId: string, @Res() res: Response) {
    try {
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
      const pdfBuffer = await generateInvoicePDF(invoice, {
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
      }, invoice.templateType || 'standard',
      // Tier 7.5: pass the resolved visual
      // config (color/font/density/
      // footer) so the PDF actually
      // reflects the per-company
      // template. Falls back to undefined
      // (hard-coded standard) when the
      // company has no template row.
      await this.resolveTemplateConfig(
        companyId,
        invoice.templateType || 'standard',
        (invoice as any).templateId,
      ));

      // Auto-save PDF to local storage
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

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}.pdf"`,
        'Content-Length': pdfBuffer.length,
      });
      res.end(pdfBuffer);
    } catch (error) {
      console.error('PDF generation error:', error);
      res.status(500).json({ error: 'PDF generation failed' });
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

      const xrechnungData = transformToXRechnungData(invoice, company);
      const xmlContent = generateXRechnung(xrechnungData);

      const buffer = Buffer.from(xmlContent, 'utf-8');

      res.set({
        'Content-Type': 'application/xml',
        'Content-Disposition': `attachment; filename="${invoice.invoiceNumber}_xrechnung.xml"`,
        'Content-Length': buffer.length,
      });
      res.end(buffer);
    } catch (error) {
      console.error('XRechnung generation error:', error);
      res.status(500).json({ error: 'XRechnung generation failed' });
    }
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
      console.error('ZUGFeRD generation error:', error);
      res.status(500).json({ error: 'ZUGFeRD generation failed' });
    }
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
    @Body('status') status: string,
  ) {
    return this.invoiceService.updateStatus(id, companyId, status);
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
    @Body() body: {
      ccEmail?: string;
      extraCc?: string[];
      overrideTo?: string;
      overrideSubject?: string;
      overrideBody?: string;
      language?: 'de' | 'en' | 'zh';
      salutation?: string;
      createdById?: string;
    },
  ) {
    const invoice = await this.invoiceService.findOne(id, companyId);
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const customer = invoice.customer;

    // Recipient resolution: overrideTo (form) > customer.contact.email
    // (DB). Validate overrideTo if provided — the form should not be
    // able to inject arbitrary content as the recipient.
    const defaultRecipient = (customer?.contact as any)?.email;
    const recipientEmail = (body?.overrideTo || defaultRecipient || '').trim();
    if (!recipientEmail) {
      throw new Error('Kunde hat keine E-Mail-Adresse hinterlegt');
    }
    // Basic RFC 5322 sanity check — the full RFC is huge; we just
    // catch the obvious "no @" / "no domain" cases. The SMTP
    // transporter does the authoritative validation.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      throw new BadRequestException(`Ungültige Empfänger-E-Mail: ${recipientEmail}`);
    }

    const recipientName = customer.name || '';
    const invoiceNumber = invoice.invoiceNumber;
    const totalAmount = parseFloat(invoice.total.toString());
    const lang: EmailLang =
      body?.language === 'en' || body?.language === 'zh' ? body.language : 'de';

    // Locale-aware number / date formatting. Matches what the
    // frontend shows in the form-preview (so what the user sees
    // is what gets sent).
    const fmtAmount = (n: number, l: EmailLang): string => {
      try {
        const locale = l === 'de' ? 'de-DE' : l === 'en' ? 'en-US' : 'zh-CN';
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: invoice.currency || 'EUR',
        }).format(n);
      } catch {
        return `${n.toFixed(2)} ${invoice.currency || 'EUR'}`;
      }
    };
    const fmtDate = (d: Date | null, l: EmailLang): string => {
      if (!d) return '—';
      try {
        const locale = l === 'de' ? 'de-DE' : l === 'en' ? 'en-US' : 'zh-CN';
        return new Intl.DateTimeFormat(locale, {
          day: '2-digit', month: '2-digit', year: 'numeric',
        }).format(d);
      } catch {
        return d.toISOString().slice(0, 10);
      }
    };

    const salutation = (body?.salutation && body.salutation.trim()) ||
      defaultSalutationFor(lang, !!recipientName.trim());

    // Render the template (used as the default if the form didn't
    // override subject / body).
    const tpl = renderInvoiceEmail(lang, {
      invoiceNumber,
      customerName: recipientName,
      amount: fmtAmount(totalAmount, lang),
      dueDate: fmtDate(invoice.dueDate ? new Date(invoice.dueDate) : null, lang),
      companyName: company?.name || '',
      salutation,
    });

    // Apply user overrides (length-capped to keep a malicious payload
    // from filling a 100KB subject line).
    const subject = (body?.overrideSubject || tpl.subject).slice(0, 250).trim();
    const text = (body?.overrideBody || tpl.text).slice(0, 4000).trim();

    // Build PDF buffer (with tier 7.5
    // visual config from the per-company
    // InvoiceTemplate if any)
    const renderConfig = await this.resolveTemplateConfig(
      companyId,
      invoice.templateType || 'standard',
      (invoice as any).templateId,
    )
    const pdfBuffer = await generateInvoicePDF(
      invoice,
      {
        name: company?.name || '',
        address: company?.address || {},
        vatId: company?.vatId || undefined,
        taxId: company?.taxId || undefined,
        bankInfo: company?.bankInfo || undefined,
        logoPath: company?.logoPath || undefined,
      },
      invoice.templateType || 'standard',
      renderConfig,
    );

    // CC: explicit user email (from request) is the primary mechanism.
    // We don't pull from Company because there's no email field on Company;
    // settings.email could be a future addition.
    const ccList: string[] = [];
    if (body?.ccEmail && body.ccEmail.trim()) ccList.push(body.ccEmail.trim());
    if (Array.isArray(body?.extraCc)) {
      for (const c of body.extraCc) {
        if (typeof c === 'string' && c.trim()) ccList.push(c.trim());
      }
    }

    // Send
    const result = await this.mailService.send(companyId, {
      to: recipientEmail,
      cc: ccList.length ? ccList : undefined,
      subject,
      text,
      attachments: [
        {
          filename: `${invoiceNumber}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    // Mark invoice as sent (best-effort)
    try {
      await this.prisma.invoice.update({
        where: { id },
        data: { status: invoice.status === 'draft' ? 'sent' : invoice.status },
      });
    } catch (e) {
      /* ignore */
    }

    // Record email send — gracefully handle invalid createdById (FK constraint)
    const smtpConfigured = await this.mailService.isConfiguredFor(companyId);
    let createdById: string | undefined = body?.createdById;
    if (createdById) {
      const userExists = await this.prisma.user.findUnique({ where: { id: createdById } });
      if (!userExists) createdById = undefined;
    }
    const emailSend = await this.prisma.emailSend.create({
      data: {
        companyId,
        invoiceId: id,
        templateType: 'invoice',
        recipientEmail,
        recipientName,
        subject,
        bodyPreview: text.slice(0, 500),
        attachmentPaths: [`${invoiceNumber}.pdf`],
        status: smtpConfigured ? 'sent' : 'opened',
        sentAt: new Date(),
        createdById,
      },
    });

    return {
      success: true,
      emailSendId: emailSend.id,
      messageId: result.messageId,
      recipient: recipientEmail,
      cc: ccList,
      subject,
      smtpConfigured,
      language: lang,
    };
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
  @Post('bulk-send-email')
  @Require('invoice.send')
  async bulkSendEmails(
    @Query('companyId') companyId: string,
    @Body() body: {
      invoiceIds?: string[];
      language?: 'de' | 'en' | 'zh';
      overrideSubject?: string;
      overrideBody?: string;
      ccEmail?: string;
      extraCc?: string[];
      createdById?: string;
      dryRun?: boolean;
      concurrency?: number;
    },
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
    @Body() body: {
      amount: number;
      paymentDate: string;
      paymentMethod: string;
      reference?: string;
      notes?: string;
      receiptNumber?: string;
    },
  ) {
    if (!body || !body.amount || !body.paymentDate || !body.paymentMethod) {
      throw new Error('Betrag, Datum und Zahlungsweg sind erforderlich');
    }
    return this.paymentService.create(id, companyId, {
      amount: Number(body.amount),
      paymentDate: new Date(body.paymentDate),
      paymentMethod: body.paymentMethod,
      reference: body.reference,
      notes: body.notes,
      receiptNumber: body.receiptNumber,
    });
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
}