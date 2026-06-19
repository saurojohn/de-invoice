/**
 * Auto-reminder cron — runs daily at 09:00 Europe/Berlin
 * and sends Mahnung (Zahlungserinnerung / 1. Mahnung /
 * Letzte Mahnung) for every overdue invoice that hasn't
 * already been reminded at the right level today.
 *
 * Three things have to be right or customers get the
 * wrong letter (or worse, the same letter twice):
 *
 *   3a. Cron schedule — every day at 09:00 Berlin,
 *       NOT 09:00 UTC. (Implemented in @Cron below.)
 *
 *   3b. Werktage-aware overdue counting — German
 *       Mahnung uses Werktag (Mon-Fri, no Feiertag),
 *       not calendar days. A Sat/Sun due date isn't
 *       "2 days overdue" on Monday — it's "0 Werktage
 *       overdue, the customer wasn't even late yet".
 *
 *   3d. Idempotency — same (companyId, invoiceId,
 *       level) tuple may only fire ONCE per day, so
 *       a server restart at 09:05 doesn't send a
 *       second Mahnung. We use a Postgres unique
 *       constraint + a SELECT first to avoid the
 *       throw + P2002 dance.
 *
 *   3e. Per-company toggle — Company.settings.
 *       autoReminderEnabled controls whether the cron
 *       even looks at this company. Defaults to true
 *       so newly-created companies get reminders out
 *       of the box; admin can disable in Settings.
 *
 *   3c. PDF attachment — every Mahnung has a real
 *       PDF attached (mahnung-pdf.service), not just
 *       email body. The PDF is the legally-binding
 *       document; email body is courtesy.
 *
 * Errors in one company must NOT block other companies.
 * We try/catch per-company and log the error so a single
 * broken invoice doesn't silently kill the whole morning
 * cron.
 */
import { Injectable, Logger } from "@nestjs/common"
import { Cron } from "@nestjs/schedule"
import { PrismaService } from "../../prisma/prisma.service"
import { MailService } from "../mail/mail.service"
import { ReminderService } from "./reminder.service"
import {
  generateMahnungPDF,
  computeNeueFrist,
} from "./mahnung-pdf.service"
import { countWerktage, isWerktag } from "./werktage"
import { ErrorTrackingService } from "../system/error-tracking.service"

const LEVELS: Array<"first" | "second" | "final"> = ["first", "second", "final"]
const BANK_LINE = (bank: any): string => {
  if (!bank) return ""
  const parts: string[] = []
  if (bank.accountHolder) parts.push(bank.accountHolder)
  if (bank.iban) parts.push(`IBAN: ${bank.iban}`)
  if (bank.bic) parts.push(`BIC: ${bank.bic}`)
  if (bank.bankName) parts.push(`bei ${bank.bankName}`)
  return parts.join(", ")
}

@Injectable()
export class AutoReminderService {
  private readonly logger = new Logger(AutoReminderService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly reminders: ReminderService,
    private readonly errors: ErrorTrackingService,
  ) {}

  /**
   * Daily 09:00 Europe/Berlin. NestJS @nestjs/schedule
   * cron uses the IANA timezone string so DST transitions
   * are automatic. Without the timeZone parameter the cron
   * fires at 09:00 UTC = 11:00/10:00 Berlin depending on
   * DST — wrong window for B2B email.
   */
  @Cron("0 9 * * *", { timeZone: "Europe/Berlin" })
  async runDaily() {
    if (process.env.DISABLE_CRON === "1") {
      this.logger.log("[AUTO-REMINDER] disabled by env, skipping")
      return
    }
    this.logger.log("[AUTO-REMINDER] daily run starting")
    const summary = { sent: 0, skipped: 0, failed: 0, companies: 0 }
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Walk all companies. Per-company try/catch so one
    // broken tenant doesn't kill the whole run.
    const companies = await this.prisma.company.findMany({
      select: { id: true, name: true, settings: true },
    })
    for (const company of companies) {
      try {
        const settings = (company.settings as any) || {}
        // 3e: per-company toggle. Default true (on) so
        // new companies get reminders immediately.
        if (settings.autoReminderEnabled === false) {
          this.logger.debug(
            `[AUTO-REMINDER] ${company.name}: autoReminderEnabled=false, skipping`,
          )
          summary.skipped += 1
          continue
        }
        summary.companies += 1
        const sent = await this.runForCompany(company.id, today)
        summary.sent += sent
      } catch (err: any) {
        summary.failed += 1
        this.logger.error(
          `[AUTO-REMINDER] ${company.name} failed: ${err?.message ?? err}`,
        )
        // Don't crash the cron — record to ErrorEvent
        // so it shows up in the dashboard.
        await this.errors
          .capture({
            source: "backend",
            kind: "manual",
            message: `Auto-reminder failed for ${company.name}: ${err?.message ?? err}`,
            stack: err?.stack,
            context: { companyId: company.id },
          })
          .catch(() => {})
      }
    }
    this.logger.log(
      `[AUTO-REMINDER] done: ${summary.sent} sent, ${summary.skipped} skipped, ${summary.failed} failed, ${summary.companies} companies`,
    )
    return summary
  }

  /**
   * Process one company. Returns the number of Mahnung
   * emails sent (success only — failures are caught and
   * logged at the per-company level).
   */
  async runForCompany(companyId: string, today: Date): Promise<number> {
    const overdue = await this.reminders.findOverdueInvoices(companyId)
    if (overdue.length === 0) return 0

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) return 0

    let sent = 0
    for (const inv of overdue) {
      try {
        const customerEmail =
          inv.customer?.contact?.email || (inv.customer as any)?.email
        if (!customerEmail) {
          this.logger.debug(
            `[AUTO-REMINDER] invoice ${inv.invoiceNumber}: no customer email, skipping`,
          )
          continue
        }
        // 3b: Werktage-aware overdue.
        // findOverdueInvoices already computes daysOverdue
        // as calendar days. We re-derive the Werktage
        // count here using the same start (dueDate).
        const dueDate = inv.dueDate ? new Date(inv.dueDate) : null
        if (!dueDate) continue
        const werktageOverdue = Math.max(0, countWerktage(dueDate, today))

        // Decide which level to send. The escalation
        // rule (from reminder.service.getNextReminderLevel):
        //   0 prior reminders → first
        //   1 prior         → second
        //   2+ prior        → final
        const level = this.reminders.getNextReminderLevel(inv.reminderCount)
        if (!level) continue

        // 3d: idempotency — don't send if a Mahnung for
        // THIS invoice at THIS level was already sent
        // today. We use a SELECT first to avoid the
        // unique-constraint P2002 dance (P2002 would
        // also work but logs noise on the race).
        const todayStart = new Date(today)
        const todayEnd = new Date(today)
        todayEnd.setDate(todayEnd.getDate() + 1)
        const alreadySent = await this.prisma.emailSend.findFirst({
          where: {
            companyId,
            invoiceId: inv.id,
            templateType: `reminder_${level}`,
            sentAt: { gte: todayStart, lt: todayEnd },
          },
        })
        if (alreadySent) {
          this.logger.debug(
            `[AUTO-REMINDER] ${inv.invoiceNumber}/${level}: already sent today, skipping`,
          )
          continue
        }

        // Only send if the invoice is overdue by enough
        // Werktage for this level. Otherwise customers
        // get a Mahnung the day after the due date, which
        // is too aggressive.
        const minOverdue = level === "first" ? 1 : level === "second" ? 7 : 14
        if (werktageOverdue < minOverdue) continue

        // 3c: generate Mahnung PDF and prepare the email.
        const neueFrist = computeNeueFrist(today, level)
        const total = Number(inv.total) || 0
        const bankLine = BANK_LINE(company.bankInfo)
        const pdfBuffer = await generateMahnungPDF({
          level,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: new Date(inv.issueDate),
          dueDate,
          totalAmount: total,
          customer: inv.customer,
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
          daysOverdue: inv.daysOverdue,
          werktageOverdue,
          neueFrist: neueFrist.toISOString(),
          bankLine,
        })

        // Render the email subject + body using the
        // same template pipeline the manual send uses.
        // renderForInvoice takes (invoiceId, companyId, level),
        // NOT the full invoice object — common footgun.
        const rendered = await this.reminders.renderForInvoice(
          inv.id,
          companyId,
          level,
        )
        const subject = rendered.subject
        const bodyText = rendered.body

        // Send the email with the PDF attached.
        await this.mail.send(companyId, {
          to: customerEmail,
          subject,
          text: bodyText,
          attachments: [
            {
              filename: `${LEVEL_TITLE_FILENAME[level]}-${inv.invoiceNumber}.pdf`,
              content: pdfBuffer,
              contentType: "application/pdf",
            },
          ],
        })

        // Record the EmailSend row (same path the
        // manual /reminders/send route uses, so the
        // dashboard shows the send and reminderCount
        // increments).
        await this.reminders.recordReminderSend(
          companyId,
          inv.id,
          customerEmail,
          inv.customer.contact?.name || inv.customer.name,
          subject,
          bodyText,
          level,
          // createdById: null for cron-triggered sends
          undefined,
        )

        sent += 1
        this.logger.log(
          `[AUTO-REMINDER] sent ${level} to ${inv.invoiceNumber} (${inv.daysOverdue}d / ${werktageOverdue}W overdue)`,
        )
      } catch (err: any) {
        // Per-invoice error must not block other invoices.
        this.logger.error(
          `[AUTO-REMINDER] invoice ${inv.invoiceNumber} failed: ${err?.message ?? err}`,
        )
        await this.errors
          .capture({
            source: "backend",
            kind: "manual",
            message: `Mahnung send failed for ${inv.invoiceNumber}: ${err?.message ?? err}`,
            stack: err?.stack,
            context: { companyId, invoiceId: inv.id, level: this.reminders.getNextReminderLevel(inv.reminderCount) },
          })
          .catch(() => {})
      }
    }
    return sent
  }
}

const LEVEL_TITLE_FILENAME: Record<"first" | "second" | "final", string> = {
  first: "Zahlungserinnerung",
  second: "Mahnung",
  final: "Letzte-Mahnung",
}
