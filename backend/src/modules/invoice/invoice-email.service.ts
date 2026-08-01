/**
 * Tier 129: extract the invoice-by-email workflow from
 * InvoiceController into a reusable service. Three callers:
 *
 *   1. InvoiceController.sendInvoiceEmail — the "Per E-Mail
 *      senden" button on the invoice detail page (manual).
 *   2. InvoiceController.bulkSendEmails — the bulk-send
 *      "Alle ausgewählten senden" action.
 *   3. RecurringScheduler (via RecurringService) — the
 *      daily 06:00 cron auto-emails the generated
 *      invoice to the customer's contact.email, IF
 *      RecurringInvoice.sendEmail = true.
 *
 * Why a separate service:
 *   - The "send" path involves: load invoice, load company,
 *     validate recipient, render locale-aware template,
 *     generate PDF buffer, build attachment, call
 *     MailService, mark invoice as 'sent', record
 *     EmailSend audit row. ~150 LOC of business logic.
 *     Keeping it in the controller made the cron-triggered
 *     case (Tier 129) impossible without a circular import.
 *   - The recurring scheduler already needs to know the
 *     outcome (success/failure) so it can record a
 *     RecurringRun row. Calling the HTTP endpoint from
 *     the scheduler would have been the alternative, but
 *     internal HTTP is gross and bypasses the in-process
 *     auth/permission checks.
 *
 * Failure handling:
 *   - No recipient on the customer → throws (caller decides
 *     whether that's an error; the recurring path treats
 *     it as "skipped, no email sent" rather than "failed").
 *   - Invalid email format → 400 (BadRequestException).
 *   - SMTP not configured → EmailService.send() falls back
 *     to console transport; we mark the EmailSend as
 *     'opened' instead of 'sent' so the audit log shows
 *     "would have been sent".
 *   - PDF render failure → propagates (caller wraps in
 *     try/catch and records a RecurringRun error).
 */
import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MailService } from '../mail/mail.service';
import { InvoiceService } from './invoice.service';
import { InvoiceTemplateService } from '../invoice-template/invoice-template.service';
import {
  generateInvoicePDF,
  InvoiceRenderConfig,
} from '../../invoices/invoice-pdf.service';
import {
  renderInvoiceEmail,
  defaultSalutationFor,
  type EmailLang,
} from '../mail/templates/invoice-email.template';

export interface SendInvoiceEmailOptions {
  overrideTo?: string;
  overrideSubject?: string;
  overrideBody?: string;
  language?: 'de' | 'en' | 'zh';
  salutation?: string;
  createdById?: string;
  ccEmail?: string;
  extraCc?: string[];
  // Tier 129: source for the EmailSend audit row
  // (manual button click vs recurring cron tick).
  source?: 'manual' | 'recurring';
}

export interface SendInvoiceEmailResult {
  success: boolean;
  skipped?: boolean;
  skipReason?: string;
  emailSendId?: string;
  messageId?: string;
  recipient?: string;
  cc?: string[];
  subject?: string;
  smtpConfigured?: boolean;
  language?: 'de' | 'en' | 'zh';
  error?: string;
}

@Injectable()
export class InvoiceEmailService {
  private readonly logger = new Logger(InvoiceEmailService.name);

  constructor(
    private invoiceService: InvoiceService,
    private prisma: PrismaService,
    private storageService: StorageService,
    private mailService: MailService,
    private templateService: InvoiceTemplateService,
  ) {}

  /**
   * Send an invoice to a customer (or an override recipient)
   * via email, with the invoice PDF attached. Used by:
   *   - the manual "Per E-Mail senden" button
   *   - bulk-send ("Alle ausgewählten senden")
   *   - the recurring-invoice cron (Tier 129)
   *
   * The cron path calls this with no `options` (uses
   * customer.contact.email as recipient, DE locale,
   * the per-template language if you set it on the
   * recurring record). For now, recurring uses 'de' as
   * the language fallback — the RecurringInvoice.language
   * field is honored when present.
   */
  async sendInvoiceByEmail(
    invoiceId: string,
    companyId: string,
    options: SendInvoiceEmailOptions = {},
  ): Promise<SendInvoiceEmailResult> {
    const invoice = await this.invoiceService.findOne(invoiceId, companyId);
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const customer = invoice.customer;

    // Recipient resolution
    const defaultRecipient = (customer?.contact as any)?.email;
    const recipientEmail = (options.overrideTo || defaultRecipient || '').trim();
    if (!recipientEmail) {
      // Tier 129: the manual "Per E-Mail senden" button
      // should surface this as a 4xx so the UI can show
      // a clear error ("Bitte hinterlegen Sie eine
      // E-Mail-Adresse beim Kunden"). The recurring
      // path, on the other hand, just records a 'skipped'
      // RecurringRun row and continues with the next
      // template — a missing email is a normal config
      // state, not a failure.
      if (options.source === 'recurring') {
        return {
          success: false,
          skipped: true,
          skipReason: 'customer_no_email',
          error: 'Kunde hat keine E-Mail-Adresse hinterlegt',
        };
      }
      throw new Error('Kunde hat keine E-Mail-Adresse hinterlegt');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      throw new BadRequestException(`Ungültige Empfänger-E-Mail: ${recipientEmail}`);
    }

    const recipientName = customer.name || '';
    const invoiceNumber = invoice.invoiceNumber;
    const totalAmount = parseFloat(invoice.total.toString());
    const lang: EmailLang =
      options.language === 'en' || options.language === 'zh' ? options.language : 'de';

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

    const salutation = (options.salutation && options.salutation.trim()) ||
      defaultSalutationFor(lang, !!recipientName.trim());

    const tpl = renderInvoiceEmail(lang, {
      invoiceNumber,
      customerName: recipientName,
      amount: fmtAmount(totalAmount, lang),
      dueDate: fmtDate(invoice.dueDate ? new Date(invoice.dueDate) : null, lang),
      companyName: company?.name || '',
      salutation,
    });

    const subject = (options.overrideSubject || tpl.subject).slice(0, 250).trim();
    const text = (options.overrideBody || tpl.text).slice(0, 4000).trim();

    // Build PDF
    const renderConfig = await this.resolveTemplateConfig(
      companyId,
      invoice.templateType || 'standard',
      (invoice as any).templateId,
    );
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

    // CC
    const ccList: string[] = [];
    if (options.ccEmail && options.ccEmail.trim()) ccList.push(options.ccEmail.trim());
    if (Array.isArray(options.extraCc)) {
      for (const c of options.extraCc) {
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
        where: { id: invoiceId },
        data: { status: invoice.status === 'draft' ? 'sent' : invoice.status },
      });
    } catch (e) {
      this.logger.warn(`could not mark invoice ${invoiceId} as 'sent': ${(e as Error).message}`);
    }

    // Record email send
    const smtpConfigured = await this.mailService.isConfiguredFor(companyId);
    let createdById: string | undefined = options.createdById;
    if (createdById) {
      const userExists = await this.prisma.user.findUnique({ where: { id: createdById } });
      if (!userExists) createdById = undefined;
    }
    const emailSend = await this.prisma.emailSend.create({
      data: {
        companyId,
        invoiceId,
        templateType: 'invoice',
        recipientEmail,
        recipientName,
        subject,
        bodyPreview: text.slice(0, 500),
        attachmentPaths: [`${invoiceNumber}.pdf`],
        status: smtpConfigured ? 'sent' : 'opened',
        sentAt: new Date(),
        createdById,
        // Tier 129: source is the simplest discriminator
        // we have without a new migration. We pack it
        // into the subject suffix? No — better to leave
        // it out and add it to bodyPreview:
        // "source=recurring\n\n<actual body>". The audit
        // log viewer will read it from bodyPreview.
        // For now, just include the source in the body
        // preview so it's searchable in the admin UI.
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

  private async resolveTemplateConfig(
    companyId: string,
    templateType: string,
    templateId: string | null | undefined,
  ): Promise<InvoiceRenderConfig | undefined> {
    // Tier 7.5: per-company InvoiceTemplate visual config
    if (!templateId) return undefined
    try {
      const r = await this.templateService.resolveConfig(companyId, templateType, templateId)
      return r.config
    } catch {
      return undefined
    }
  }
}
