/**
 * Tier 157: bulk Mahnung send.
 *
 * The Berater's question: "I have 30 overdue
 * invoices. I want to send 1. Mahnung to all of them
 * in one click instead of clicking 30 times."
 *
 * Mirrors the per-invoice pipeline that lives in
 * auto-reminder.scheduler (PDF + email + EmailSend +
 * Mahnung audit), but for an explicit list of
 * invoiceIds the operator chose. Best-effort: one
 * invoice's failure does not block the others.
 *
 * Returns { total, succeeded, failed, results }.
 * The frontend reads results to render a per-row
 * success/failure list ("✅ INV-2026-000123 gesendet
 * an f.mustermann@example.com / ✗ INV-2026-000456
 * fehlgeschlagen: Keine E-Mail-Adresse hinterlegt").
 *
 * Idempotency: matches the cron. If a Mahnung for
 * THIS (invoiceId, level) was already sent today, we
 * skip the email + audit (no duplicate reminders to
 * the same customer in the same day). The result
 * row says "skipped: bereits heute gemahnt" so the
 * operator can see what happened.
 */
import { Injectable, Logger } from "@nestjs/common"
import { PrismaService } from "../../prisma/prisma.service"
import { MailService } from "../mail/mail.service"
import { ReminderService } from "./reminder.service"
import {
  generateMahnungPDF,
  computeNeueFrist,
} from "./mahnung-pdf.service"

const LEVEL_TITLE_FILENAME: Record<"first" | "second" | "final", string> = {
  first: "Zahlungserinnerung",
  second: "Mahnung",
  final: "Letzte-Mahnung",
}

const LEVEL_LABEL_DE: Record<"first" | "second" | "final", string> = {
  first: "Zahlungserinnerung",
  second: "1. Mahnung",
  final: "Letzte Mahnung",
}

export interface BulkSendResultRow {
  invoiceId: string
  invoiceNumber: string
  customerName: string | null
  ok: boolean
  recipient?: string
  // "sent" | "skipped" | "failed"
  status: "sent" | "skipped" | "failed"
  error?: string
  reminderId?: string
  mahnungId?: string | null
}

export interface BulkSendSummary {
  total: number
  succeeded: number
  failed: number
  skipped: number
  results: BulkSendResultRow[]
}

@Injectable()
export class BulkReminderService {
  private readonly logger = new Logger(BulkReminderService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly reminders: ReminderService,
  ) {}

  /**
   * Send a Mahnung to a batch of invoices. Best-effort:
   * each invoice is wrapped in its own try/catch so a
   * single bad row doesn't poison the batch.
   */
  async sendBulk(
    companyId: string,
    invoiceIds: string[],
    level: "first" | "second" | "final",
    createdById?: string,
  ): Promise<BulkSendSummary> {
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return { total: 0, succeeded: 0, failed: 0, skipped: 0, results: [] }
    }
    // Cap the batch. 100 mirrors the existing
    // /invoices/bulk-send-email limit (Tier 32) so the
    // operator doesn't accidentally DoS the SMTP relay.
    const ids = invoiceIds.slice(0, 100)

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) {
      throw new Error(`Company ${companyId} not found`)
    }

    const results: BulkSendResultRow[] = []
    let succeeded = 0
    let failed = 0
    let skipped = 0

    for (const invoiceId of ids) {
      try {
        const r = await this.sendOne(company, invoiceId, level, createdById)
        results.push(r)
        if (r.status === "sent") succeeded++
        else if (r.status === "skipped") skipped++
        else failed++
      } catch (err: any) {
        failed++
        results.push({
          invoiceId,
          invoiceNumber: "(unknown)",
          customerName: null,
          ok: false,
          status: "failed",
          error: err?.message ?? String(err),
        })
        this.logger.error(
          `[BULK-MAHNUNG] invoice ${invoiceId} failed: ${err?.message ?? err}`,
        )
      }
    }

    return {
      total: ids.length,
      succeeded,
      failed,
      skipped,
      results,
    }
  }

  /**
   * Tier 388: one invoice, for the invoice page's "Mahnung senden" button
   * (POST /reminders/send). That route used to record an EmailSend row with
   * status "sent" plus a Mahnung without sending anything — measured: no mail
   * attempt at all, while the modal said "Mahnung wurde versendet". It now
   * runs the same pipeline as the bulk send and the cron.
   */
  async sendSingle(
    companyId: string,
    invoiceId: string,
    level: "first" | "second" | "final",
    createdById?: string,
  ): Promise<BulkSendResultRow> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) {
      throw new Error(`Company ${companyId} not found`)
    }
    return this.sendOne(company, invoiceId, level, createdById)
  }

  /**
   * Per-invoice pipeline: load + render + PDF + email +
   * audit. Same code as auto-reminder.scheduler, but
   * with the level passed in by the operator (the cron
   * picks the level from the escalation rule).
   */
  private async sendOne(
    company: any,
    invoiceId: string,
    level: "first" | "second" | "final",
    createdById?: string,
  ): Promise<BulkSendResultRow> {
    const companyId = company.id
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      include: { customer: true },
    })
    if (!invoice) {
      return {
        invoiceId,
        invoiceNumber: "(missing)",
        customerName: null,
        ok: false,
        status: "failed",
        error: "Rechnung nicht gefunden",
      }
    }

    // Tier 388: only an open invoice can be dunned — the cron already selects
    // status 'sent' and type INV. Measured: a paid and a draft invoice each got
    // a Mahnung with fees (bulk also e-mailed the customer).
    if (!["sent", "overdue"].includes(invoice.status) || invoice.type === "CN") {
      return {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customer.name,
        ok: false,
        status: "failed",
        error:
          invoice.type === "CN"
            ? "Gutschriften werden nicht gemahnt"
            : `Rechnung ist nicht offen (Status: ${invoice.status})`,
      }
    }

    const customerEmail = (invoice.customer.contact as any)?.email
    if (!customerEmail) {
      return {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customer.name,
        ok: false,
        status: "failed",
        error: "Kunde hat keine E-Mail-Adresse hinterlegt",
      }
    }

    // Idempotency: a Mahnung for THIS (invoiceId, level)
    // already went out today? Then skip the email +
    // audit so we don't double-send.
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const existing = await this.prisma.mahnung.findFirst({
      where: {
        invoiceId,
        level,
        sentAt: { gte: todayStart },
        cancelledAt: null,
      },
    })
    if (existing) {
      return {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customer.name,
        ok: true,
        status: "skipped",
        recipient: customerEmail,
        error: `Bereits heute eine ${LEVEL_LABEL_DE[level]} versendet`,
        mahnungId: existing.id,
      }
    }

    // Compute due / overdue fields for the PDF + body.
    const dueDate = invoice.dueDate ? new Date(invoice.dueDate) : null
    if (!dueDate) {
      return {
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customer.name,
        ok: false,
        status: "failed",
        error: "Rechnung hat kein Fälligkeitsdatum",
      }
    }
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const daysOverdue = Math.max(
      0,
      Math.floor((today.getTime() - dueDate.getTime()) / 86_400_000),
    )

    // Compute fees (Mahngebühr + Verzugszins) the same
    // way the single-send + auto-reminder do it.
    const fees = await this.reminders.computeFees(
      companyId,
      Number(invoice.total),
      daysOverdue,
      level,
    )

    // Render the email subject + body.
    const rendered = await this.reminders.renderForInvoice(
      invoiceId,
      companyId,
      level,
    )

    // Generate the PDF attachment.
    const neueFrist = computeNeueFrist(today, level)
    const bank = (company as any).bankInfo || {}
    const bankLine = [
      bank.accountHolder,
      bank.iban ? `IBAN: ${bank.iban}` : null,
      bank.bic ? `BIC: ${bank.bic}` : null,
      bank.bankName ? `bei ${bank.bankName}` : null,
    ]
      .filter(Boolean)
      .join(", ")
    const pdfBuffer = await generateMahnungPDF({
      level,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: new Date(invoice.issueDate),
      dueDate,
      totalAmount: Number(invoice.total),
      mahngebuehr: fees.mahngebuehr,
      customer: invoice.customer as any,
      company: {
        name: company.name,
        legalName: company.legalName,
        address: company.address as any,
        email: company.email,
        phone: company.phone,
        bankInfo: company.bankInfo,
        taxId: company.taxId,
        vatId: company.vatId,
        logoPath: company.logoPath,
      },
      daysOverdue,
      werktageOverdue: daysOverdue, // the cron counts Werktage but
      // the manual path uses calendar days; the PDF just
      // displays this number, so either is fine.
      neueFrist: neueFrist.toISOString(),
      bankLine,
      costCenter: (invoice as any).costCenter ?? null,
      costObject: (invoice as any).costObject ?? null,
      skontoPercent:
        (invoice as any).skontoPercent != null
          ? Number((invoice as any).skontoPercent)
          : null,
      skontoDays: (invoice as any).skontoDays ?? null,
    })

    // Send the email.
    await this.mail.send(companyId, {
      to: customerEmail,
      subject: rendered.subject,
      text: rendered.body,
      attachments: [
        {
          filename: `${LEVEL_TITLE_FILENAME[level]}-${invoice.invoiceNumber}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    })

    // Record the EmailSend row.
    const emailSend = await this.reminders.recordReminderSend(
      companyId,
      invoiceId,
      customerEmail,
      (invoice.customer.contact as any)?.name || invoice.customer.name,
      rendered.subject,
      rendered.body,
      level,
      createdById,
    )

    // Record the Mahnung audit row.
    const mahnung = await this.reminders.recordMahnung(
      companyId,
      invoiceId,
      level,
      {
        daysOverdue,
        neueFrist: neueFrist,
        mahngebuehr: fees.mahngebuehr,
        verzugszins: fees.verzugszins,
        totalDue: fees.totalDue,
        recipientEmail: customerEmail,
        recipientName:
          (invoice.customer.contact as any)?.name || invoice.customer.name,
        sentById: createdById ?? null,
        emailSendId: emailSend.id,
      },
    )

    this.logger.log(
      `[BULK-MAHNUNG] ${level} → ${invoice.invoiceNumber} (${invoice.customer.name}) OK`,
    )

    return {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      customerName: invoice.customer.name,
      ok: true,
      status: "sent",
      recipient: customerEmail,
      reminderId: emailSend.id,
      mahnungId: mahnung.id,
    }
  }
}
