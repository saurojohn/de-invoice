/**
 * Tier 154: per-customer Kontoauszug email service.
 *
 * Wraps the existing
 *   CustomerStatementService.generate()
 * + generateStatementPdf()
 * + MailService.send()
 * + EmailSend audit row
 * into a single callable, the same way
 * InvoiceEmailService.sendInvoiceByEmail
 * wraps the invoice-by-email flow.
 *
 * Called by CustomerController.sendStatementEmail
 * (the new "📧 Per E-Mail senden" button on the
 * statement page). One customer, one PDF, one
 * email. For bulk month-end sends to all
 * customers, see CustomerStatementBatchService.
 *
 * Failure handling:
 *   - No recipient on the customer → throws
 *     BadRequestException so the UI can show
 *     a clear "bitte E-Mail-Adresse hinterlegen"
 *     error.
 *   - Invalid email format → 400.
 *   - SMTP not configured → MailService.send()
 *     falls back to console transport; we mark
 *     the EmailSend row as 'opened' instead of
 *     'sent' so the audit log shows "would have
 *     been sent" (same convention as the invoice
 *     path).
 *   - PDF render failure → propagates (caller
 *     surfaces the 500 in the UI).
 */
import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { CustomerStatementService } from './customer-statement.service';
import { generateStatementPdf } from './customer-statement-pdf.service';

export interface SendStatementEmailOptions {
  /** 'desc' (newest first) or 'asc' (oldest first).
   *  Mirrors the GET /:id/statement query param. */
  order?: 'desc' | 'asc'
  /** Optional override for the recipient (CC /
   *  alternate address). Falls back to the
   *  customer's contact.email. */
  overrideTo?: string
}

export interface SendStatementEmailResult {
  success: boolean
  /** Generated EmailSend row id. */
  emailSendId: string
  recipientEmail: string
  /** Period that was rendered. Echoed back so
   *  the UI can show "Sent for 2026-07-01 —
   *  2026-07-31". */
  period: { from: string; to: string }
  /** "would have been sent" indicator when SMTP
   *  isn't configured. Same shape as the
   *  invoice-email service returns. */
  smtpConfigured: boolean
}

@Injectable()
export class CustomerStatementEmailService {
  private readonly logger = new Logger(CustomerStatementEmailService.name);

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private statementService: CustomerStatementService,
  ) {}

  async sendStatementByEmail(
    customerId: string,
    companyId: string,
    fromStr: string,
    toStr: string,
    options: SendStatementEmailOptions = {},
  ): Promise<SendStatementEmailResult> {
    if (!companyId) throw new BadRequestException('companyId is required')
    if (!customerId) throw new BadRequestException('customerId is required')
    if (!fromStr || !toStr) {
      throw new BadRequestException('from and to are required (YYYY-MM-DD)')
    }

    // Load customer + company
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, companyId },
    })
    if (!customer) {
      throw new BadRequestException('Customer not found in this company')
    }
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company) {
      throw new BadRequestException('Company not found')
    }

    // Resolve recipient
    const defaultRecipient = (customer.contact as any)?.email
    const recipientEmail = (options.overrideTo || defaultRecipient || '').trim()
    if (!recipientEmail) {
      throw new BadRequestException(
        'Kunde hat keine E-Mail-Adresse hinterlegt. Bitte zuerst in den Kundendaten ergänzen.',
      )
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      throw new BadRequestException(`Ungültige Empfänger-E-Mail: ${recipientEmail}`)
    }

    const order: 'asc' | 'desc' = (options.order === 'asc' ? 'asc' : 'desc')

    // The service expects Date objects. The
    // controller validates the from/to strings
    // as YYYY-MM-DD; we expand to a Date range
    // with `from` at 00:00 and `to` at 23:59 so
    // the same day is included.
    const fromDate = new Date(fromStr + 'T00:00:00.000Z')
    const toDate = new Date(toStr + 'T23:59:59.999Z')

    // Generate the statement data + PDF
    const data = await this.statementService.generate(
      companyId, customerId, fromDate, toDate, order,
    )
    const pdfBuffer = await generateStatementPdf(data)

    // German email copy. Tier 154 keeps the
    // body short — the statement PDF is the
    // payload. The greeting is polite
    // standard; we don't yet have a per-
    // company template override (would be
    // Tier 154+ follow-up).
    const recipientName = customer.name
    const custNum = customer.customerNumber
    const fmtFrom = data.period.from
    const fmtTo = data.period.to
    const fmtOpen = data.closingBalance.toLocaleString('de-DE', {
      style: 'currency',
      currency: 'EUR',
    })
    const subject = `Kontoauszug ${custNum || recipientName} ${fmtFrom}–${fmtTo}`.slice(0, 250)
    const text = [
      `Sehr geehrte/r ${recipientName},`,
      ``,
      `anbei erhalten Sie Ihren Kontoauszug für den Zeitraum ${fmtFrom} bis ${fmtTo}.`,
      ``,
      `Aktueller Saldo: ${fmtOpen}`,
      ``,
      `Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.`,
      ``,
      `Mit freundlichen Grüßen`,
      `${company.name}`,
    ].join('\n')

    // Send
    const filename = `Kontoauszug_${custNum || customerId}_${fmtFrom}_${fmtTo}.pdf`
    const sendResult = await this.mailService.send(companyId, {
      to: recipientEmail,
      subject,
      text,
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    })

    // Audit row. We use templateType='statement'
    // so the customer-detail email-Verlauf
    // (Tier 144) can filter on it.
    const smtpConfigured = await this.mailService.isConfiguredFor(companyId)
    // sendResult is { messageId } from MailService.
    // The messageId is always set (dev fallback
    // returns `dev-<ts>` even when SMTP isn't
    // configured) — so we use its presence +
    // smtpConfigured to decide the EmailSend
    // status, mirroring the invoice-email path.
    const sentOk = !!sendResult?.messageId
    const emailSend = await this.prisma.emailSend.create({
      data: {
        companyId,
        invoiceId: null, // not tied to a single invoice
        templateType: 'statement',
        recipientEmail,
        recipientName,
        subject,
        bodyPreview: text.slice(0, 500),
        attachmentPaths: [filename],
        status: sentOk
          ? (smtpConfigured ? 'sent' : 'opened')
          : 'failed',
        sentAt: sentOk ? new Date() : null,
      },
    })

    this.logger.log(
      `Statement email: company=${companyId} customer=${customerId} ` +
      `period=${fmtFrom}–${fmtTo} recipient=${recipientEmail} ` +
      `emailSendId=${emailSend.id} smtp=${smtpConfigured}`,
    )

    return {
      success: true,
      emailSendId: emailSend.id,
      recipientEmail,
      period: { from: fmtFrom, to: fmtTo },
      smtpConfigured,
    }
  }
}
