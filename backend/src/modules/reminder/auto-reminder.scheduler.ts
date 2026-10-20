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
import { BulkReminderService } from "./bulk-reminder.service"
import { readDunningConfig } from "./reminder.service"
// Tier 119: every cron tick records to the shared
// CronHealthService for the admin dashboard.
import { CronHealthService } from "../admin/cron-health.service"
import { countWerktage } from "./werktage"
import { businessDayIso, businessTodayIso } from "../../common/business-date"
import { ErrorTrackingService } from "../system/error-tracking.service"
import { invoiceRecipientOf } from "../customer/invoice-recipient"

@Injectable()
export class AutoReminderService {
  private readonly logger = new Logger(AutoReminderService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly reminders: ReminderService,
    // Tier 702: the per-invoice pipeline of the manual and the bulk send
    private readonly bulk: BulkReminderService,
    private readonly errors: ErrorTrackingService,
    // Tier 119: record every cron tick to the shared
    // health table so the admin dashboard can see
    // "reminder-auto-send last ran 14h ago".
    private readonly health: CronHealthService,
  ) {}

  /**
   * Daily 09:00 Europe/Berlin. NestJS @nestjs/schedule
   * cron uses the IANA timezone string so DST transitions
   * are automatic. Without the timeZone parameter the cron
   * fires at 09:00 UTC = 11:00/10:00 Berlin depending on
   * DST — wrong window for B2B email.
   */
  @Cron("0 9 * * *", {
    name: "reminder-auto-send",
    timeZone: "Europe/Berlin",
  })
  async runDaily() {
    if (process.env.DISABLE_CRON === "1") {
      this.logger.log("[AUTO-REMINDER] disabled by env, skipping")
      return
    }
    this.logger.log("[AUTO-REMINDER] daily run starting")
    return this.health.wrap("reminder-auto-send", async () => {
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
    return `${summary.sent} sent, ${summary.skipped} skipped, ${summary.failed} failed, ${summary.companies} companies`
    })
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
          invoiceRecipientOf(inv.customer) || (inv.customer as any)?.email // Tier 719
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
        // Tier 702: the next level waits for the deadline the previous letter
        // set („neue Frist“). The thresholds count from the due date, so an
        // invoice overdue for weeks got the Zahlungserinnerung, the Mahnung
        // and the letzte Mahnung on three days running — each letter naming a
        // deadline the next one did not wait for.
        const previous = await this.prisma.mahnung.findFirst({
          where: { companyId, invoiceId: inv.id, cancelledAt: null },
          orderBy: { sentAt: "desc" },
          select: { neueFrist: true },
        })
        if (previous && businessDayIso(previous.neueFrist) >= businessTodayIso()) {
          this.logger.debug(
            `[AUTO-REMINDER] ${inv.invoiceNumber}: the deadline of the last letter (${businessDayIso(previous.neueFrist)}) is still running`,
          )
          continue
        }

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
        //
        // Tier 123: thresholds come from the per-company
        // dunning config (Company.settings.dunning).
        // Falls back to the German Mittelstand defaults
        // (1/7/14 Werktage) when unset. The config is
        // validated in `readDunningConfig` so a bad
        // config (e.g. level2 < level1) won't reach here.
        const dunningConfig = readDunningConfig(company.settings)
        const minOverdue =
          level === "first"
            ? dunningConfig.level1Days
            : level === "second"
            ? dunningConfig.level2Days
            : dunningConfig.level3Days
        if (werktageOverdue < minOverdue) continue

        // Tier 702: the letter goes through the pipeline of the manual and the
        // bulk send (BulkReminderService) — the cron had its own. Measured, on
        // a 1 190 € invoice with 500 € paid: the automatic letter demanded
        // 1 190 € (the manual one 690 € — Tier 421), charged no Verzugszinsen,
        // took its fee from another setting (Company.settings.dunning, the
        // manual one from the Mahnungen page), and wrote no Mahnung row, so
        // the dunning list, the fees booked and the "no lower level after a
        // higher one" rule (Tier 526) never saw it. The pipeline also keeps
        // the pauses and the Ratenplan hold as the manual send does.
        const result = await this.bulk.sendSingle(companyId, inv.id, level)
        if (!result.ok || result.status === "skipped") {
          this.logger.debug(
            `[AUTO-REMINDER] ${inv.invoiceNumber}/${level}: not sent — ${result.error ?? result.status}`,
          )
          continue
        }
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

