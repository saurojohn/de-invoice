import { queryDate, queryInt } from '../../common/query';
import { advanceDeductionFor } from '../invoice/advance';
import {
  Controller,
  Get,
  Put,
  Post,
  Query,
  Body,
  Param,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { MailService } from './mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Auth, Require } from '../../auth/roles.decorator';
import { isSystemAdmin } from '../../auth/system-admin.guard';
import { isSealed, sealSecret, secretEncryptionAvailable } from '../../common/secret-crypto';

interface MailConfigDto {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  fromName: string;
  fromEmail: string;
  enabled: boolean;
}

@Controller('mail')
export class MailController {
  constructor(
    private mailService: MailService,
    private prisma: PrismaService,
  ) {}

  @Require('company.read')
  @Get('config')
  async getConfig(@Query('companyId') companyId: string, @Req() req: any) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const cfg = await this.prisma.mailConfig.findUnique({ where: { companyId } });
    if (!cfg) {
      // Tier 630: the installation's own SMTP account (host, user, sender) is
      // the operator's. It was returned to every company without a mail
      // configuration "as initial values for the form" — every member of
      // every company could read the operator's mail server and account
      // name. A company learns only whether the installation sends for it.
      const installationSender = !!(process.env.SMTP_HOST && process.env.SMTP_USER);
      if (!(await isSystemAdmin(this.prisma, req?.user))) {
        return {
          configured: false,
          smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPassword: '',
          fromName: '', fromEmail: '',
          enabled: true,
          source: 'env',
          installationSender,
        };
      }
      // Return env fallback as initial values for the UI form (without password)
      return {
        installationSender,
        configured: false,
        smtpHost: process.env.SMTP_HOST || '',
        smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
        smtpSecure: process.env.SMTP_SECURE === 'true',
        smtpUser: process.env.SMTP_USER || '',
        smtpPassword: '',
        fromName: process.env.SMTP_FROM_NAME || '',
        fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '',
        enabled: true,
        source: 'env',
      };
    }
    return {
      configured: true,
      smtpHost: cfg.smtpHost,
      smtpPort: cfg.smtpPort,
      smtpSecure: cfg.smtpSecure,
      smtpUser: cfg.smtpUser,
      // Never return the password to the client (it would be plaintext over the wire)
      smtpPassword: '',
      fromName: cfg.fromName,
      fromEmail: cfg.fromEmail,
      enabled: cfg.enabled,
      source: 'database',
      updatedAt: cfg.updatedAt,
      // Tier 630: whether the stored password is sealed (the installation has its key)
      passwordEncrypted: isSealed(cfg.smtpPassword),
      encryptionAvailable: secretEncryptionAvailable(),
    };
  }

  @Require('company.update')
  @Put('config')
  async saveConfig(
    @Query('companyId') companyId: string,
    @Body() dto: Partial<MailConfigDto>,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!dto.smtpHost || !dto.smtpUser) {
      throw new BadRequestException('SMTP-Host und SMTP-Benutzer sind erforderlich');
    }

    const data = {
      smtpHost: dto.smtpHost,
      smtpPort: dto.smtpPort ?? 587,
      smtpSecure: dto.smtpSecure ?? false,
      smtpUser: dto.smtpUser,
      // If password is empty and a config exists, keep the old password.
      // Tier 630: either way it is stored sealed (AES-256-GCM under the
      // installation's key) — it was kept as typed.
      smtpPassword: sealSecret(
        dto.smtpPassword && dto.smtpPassword.length > 0
          ? dto.smtpPassword
          : (await this.prisma.mailConfig.findUnique({ where: { companyId } }))?.smtpPassword || '',
      ),
      fromName: dto.fromName || 'Ihre Firma',
      fromEmail: dto.fromEmail || dto.smtpUser,
      enabled: dto.enabled ?? true,
    };

    const cfg = await this.prisma.mailConfig.upsert({
      where: { companyId },
      create: { companyId, ...data },
      update: data,
    });

    return {
      ok: true,
      configured: true,
      smtpHost: cfg.smtpHost,
      smtpPort: cfg.smtpPort,
      smtpUser: cfg.smtpUser,
      fromEmail: cfg.fromEmail,
    };
  }

  @Require('company.update')
  @Post('test')
  async testConnection(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const result = await this.mailService.testConnection(companyId);
    return result;
  }

  /**
   * List all outbound emails for this company. The list view
   * for the Email Center dashboard. Server-side pagination
   * + filters keep the response small even for companies
   * that have sent thousands of emails.
   *
   * Filters:
   *   - status: exact match (sent / failed / opened / bounced)
   *   - invoiceId: filter to a specific invoice's emails
   *   - q: substring match on recipientEmail / subject / recipientName
   *   - dateFrom / dateTo: ISO 8601 bounds on sentAt (falls back
   *     to createdAt if sentAt is null)
   */
  @Auth()
  @Get('emails')
  @Require('invoice.read')
  async listEmails(
    @Query('companyId') companyId: string,
    @Query('page') pageStr?: string,
    @Query('pageSize') pageSizeStr?: string,
    @Query('status') status?: string,
    @Query('invoiceId') invoiceId?: string,
    @Query('q') q?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const page = queryInt(pageStr, 'page', { min: 1, max: 1_000_000 }) ?? 1
    const pageSize = Math.min(200, queryInt(pageSizeStr, 'pageSize', { min: 1, max: 10_000 }) ?? 50)

    const where: any = { companyId }
    if (status) where.status = status
    if (invoiceId) where.invoiceId = invoiceId
    if (q) {
      // OR search across recipient + subject. Postgres ILIKE
      // through the @prisma/client works for substring without
      // needing raw SQL.
      where.OR = [
        { recipientEmail: { contains: q, mode: 'insensitive' } },
        { recipientName: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
      ]
    }
    if (dateFrom || dateTo) {
      where.sentAt = {}
      if (dateFrom) where.sentAt.gte = queryDate(dateFrom, 'dateFrom')
      if (dateTo) where.sentAt.lte = queryDate(dateTo, 'dateTo')
    }

    const [rows, total] = await Promise.all([
      this.prisma.emailSend.findMany({
        where,
        orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          invoice: {
            select: { id: true, invoiceNumber: true, status: true, total: true },
          },
        },
      }),
      this.prisma.emailSend.count({ where }),
    ])

    return { data: rows, total, page, pageSize }
  }

  /**
   * Stats summary for the Email Center dashboard tile.
   * Returns counts and the total recipient count for the
   * last 30 days.
   *
   * Declared BEFORE the `:id` route so the literal
   * "stats" segment doesn't get swallowed by the param.
   */
  @Auth()
  @Get('emails/stats')
  @Require('invoice.read')
  async emailStats(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const [byStatus, total] = await Promise.all([
      this.prisma.emailSend.groupBy({
        by: ['status'],
        where: { companyId, createdAt: { gte: since } },
        _count: { status: true },
      }),
      this.prisma.emailSend.count({ where: { companyId, createdAt: { gte: since } } }),
    ])
    const counts: Record<string, number> = {}
    for (const r of byStatus) counts[r.status] = r._count.status
    return { counts, total, since: since.toISOString() }
  }

  /**
   * Get a single outbound email by id. Returns the full row
   * including bodyPreview and attachment paths so the detail
   * view can show what was sent.
   */
  @Auth()
  @Get('emails/:id')
  @Require('invoice.read')
  async getEmail(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const email = await this.prisma.emailSend.findFirst({
      where: { id, companyId },
      include: {
        invoice: {
          select: { id: true, invoiceNumber: true, status: true, total: true, customer: { select: { name: true } } },
        },
      },
    })
    if (!email) throw new BadRequestException('Email not found')
    return email
  }

  /**
   * Re-send an existing email. The original EmailSend row
   * is kept in place for the GoBD audit trail and a NEW
   * EmailSend row is created with the same data + a fresh
   * PDF. The recipient / subject / body can be overridden
   * by the caller (e.g. "send to a different address").
   *
   * Implementation: we re-use the PDF generator from the
   * invoices module and call MailService directly. We don't
   * re-delegate to InvoiceController.sendInvoiceEmail
   * because controllers aren't injected.
   *
   * Request body (all optional):
   *   to:       string  — override recipient
   *   subject:  string  — override subject
   *   body:     string  — override body
   *   ccEmail:  string  — single CC
   */
  @Auth()
  @Post('emails/:id/resend')
  @Require('invoice.send')
  async resendEmail(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: { to?: string; subject?: string; body?: string; ccEmail?: string },
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const original = await this.prisma.emailSend.findFirst({ where: { id, companyId } })
    if (!original) throw new BadRequestException('Email not found')
    if (!original.invoiceId) {
      throw new BadRequestException('Nur rechnungsgebundene E-Mails können erneut gesendet werden')
    }

    // Reuse the same PDF-rendering + mail-dispatch path
    // the invoice controller uses. We import lazily to
    // avoid a circular module dependency at boot.
    const { generateInvoicePDF } = await import('../../invoices/invoice-pdf.service')
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: original.invoiceId, companyId },
      include: {
        customer: true,
        company: true,
        // Items are required by the PDF generator
        // (it iterates them for the line-item table).
        // Product snapshot is used for SKU fallback.
        items: { include: { product: { select: { sku: true, name: true } } } },
        payments: true,
      },
    })
    if (!invoice) {
      throw new BadRequestException('Rechnung nicht gefunden')
    }
    const company = invoice.company
    const customer = invoice.customer

    // PDF buffer (regenerated — same PDF the user gets from
    // the first send, but if the invoice was edited in the
    // meantime the resend reflects the current state).
    // Tier 472: a final invoice states the advance it deducts.
    ;(invoice as any).advanceDeduction = await advanceDeductionFor(this.prisma, invoice as any)
    const pdfBuffer = await generateInvoicePDF(
      invoice as any,
      {
        name: company?.name || '',
        address: company?.address || {},
        vatId: company?.vatId || undefined,
        taxId: company?.taxId || undefined,
        bankInfo: company?.bankInfo || undefined,
        logoPath: company?.logoPath || undefined,
      },
      (invoice as any).templateType || 'standard',
    )

    // Recipient / subject / body — override > original
    const to = (body?.to || original.recipientEmail || '').trim()
    if (!to) throw new BadRequestException('Empfänger fehlt')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new BadRequestException(`Ungültige Empfänger-E-Mail: ${to}`)
    }
    const subject = (body?.subject || original.subject || '').slice(0, 250).trim()
    const text = (body?.body || original.bodyPreview || '').slice(0, 4000).trim()
    const ccList: string[] = []
    if (body?.ccEmail && body.ccEmail.trim()) ccList.push(body.ccEmail.trim())

    const result = await this.mailService.send(companyId, {
      to,
      cc: ccList.length ? ccList : undefined,
      subject,
      text,
      attachments: [
        {
          filename: `${invoice.invoiceNumber}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    })

    // New EmailSend row — preserves the audit trail (both
    // the original and the resend are recoverable).
    const smtpConfigured = await this.mailService.isConfiguredFor(companyId)
    const emailSend = await this.prisma.emailSend.create({
      data: {
        companyId,
        invoiceId: original.invoiceId,
        templateType: original.templateType || 'invoice',
        recipientEmail: to,
        recipientName: original.recipientName || customer.name,
        subject,
        bodyPreview: text.slice(0, 500),
        attachmentPaths: [`${invoice.invoiceNumber}.pdf`],
        status: smtpConfigured ? 'sent' : 'opened',
        sentAt: new Date(),
        notes: `Resend of ${original.id}`,
      },
    })

    return {
      success: true,
      originalId: original.id,
      emailSendId: emailSend.id,
      messageId: result.messageId,
      recipient: to,
      cc: ccList,
      subject,
      smtpConfigured,
    }
  }
}
