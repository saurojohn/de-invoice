import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, Res, Header } from '@nestjs/common';
import { Response } from 'express';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiverLib: any = require('archiver');
const archiver = (format: string, opts?: any) => archiverLib.create(format, opts);
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MailService } from '../mail/mail.service';
import { generateInvoicePDF } from '../../invoices/invoice-pdf.service';
import { generateXRechnung, transformToXRechnungData } from '../../invoices/xrechnung.service';
import { generateZUGFeRD } from '../../invoices/zugferd.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('invoices')
export class InvoiceController {
  constructor(
    private invoiceService: InvoiceService,
    private prisma: PrismaService,
    private storageService: StorageService,
    private mailService: MailService,
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
            buffer = await generateInvoicePDF(invoice, companyCtx as any, invoice.templateType || 'standard')
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

      const pdfBuffer = await generateInvoicePDF(invoice, {
        name: company?.name || '',
        address: company?.address || {},
        vatId: company?.vatId || undefined,
        taxId: company?.taxId || undefined,
        bankInfo: company?.bankInfo || undefined,
        logoPath: company?.logoPath || undefined,
      }, invoice.templateType || 'standard');

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
        vatId: company.vatId || undefined,
        taxId: company.taxId || undefined,
        address: company.address || {},
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

  // Send invoice via email (German content + PDF attachment + auto-CC to sender)
  @Post(':id/send-email')
  @Require('invoice.send')
  async sendInvoiceEmail(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: { ccEmail?: string; createdById?: string },
  ) {
    const invoice = await this.invoiceService.findOne(id, companyId);
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const customer = invoice.customer;

    const recipientEmail = (customer?.contact as any)?.email;
    if (!recipientEmail) {
      throw new Error('Kunde hat keine E-Mail-Adresse hinterlegt');
    }
    const recipientName = customer.name || '';
    const invoiceNumber = invoice.invoiceNumber;
    const totalAmount = parseFloat(invoice.total.toString()).toFixed(2);
    const dueDate = invoice.dueDate
      ? new Date(invoice.dueDate).toLocaleDateString('de-DE')
      : '—';

    const subject = `Rechnung ${invoiceNumber}`;
    const text =
      `Sehr geehrte/r Herr/Frau ${recipientName},\n\n` +
      `anbei erhalten Sie die Rechnung ${invoiceNumber} über EUR ${totalAmount}.\n\n` +
      `Bitte begleichen Sie den Betrag bis zum ${dueDate}.\n\n` +
      `Mit freundlichen Grüßen\n${company?.name || ''}`;

    // Build PDF buffer
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
    );

    // CC: explicit user email (from request) is the primary mechanism.
    // We don't pull from Company because there's no email field on Company;
    // settings.email could be a future addition.
    const ccList: string[] = [];
    if (body?.ccEmail) ccList.push(body.ccEmail);

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
}