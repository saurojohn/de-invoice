/**
 * Nightly cron for VIES re-verification.
 *
 * Schedule: 02:00 every day Europe/Berlin. At that
 * moment we walk every customer + supplier row that
 * has a VAT ID and whose last 'valid' check is
 * older than CACHE_TTL_DAYS (30 days — see
 * VatValidationService). For each, we call
 * validateAndLog() which:
 *   - returns the cached 'valid' result if recent
 *   - hits VIES otherwise and writes a new log row
 *
 * Rate limiting: the per-msCode token bucket in
 * VatValidationService caps us at 30 req/min per
 * country. A 1000-customer nightly run with mixed
 * DE/FR/IT will take 30+ minutes — that's fine
 * because the cron runs at 02:00 and stores its
 * progress implicitly in the VatValidationLog table.
 *
 * Notifications: when a row's status TRANSITIONS
 * (valid → invalid, or invalid → valid, or
 * unreachable → valid/invalid), we email the
 * company's primary address. This is a
 * "something changed, please look" notification,
 * NOT a nightly spam — a customer that's been
 * valid for 2 years will NOT generate an email
 * just because we re-checked.
 *
 * Env override:
 *   DISABLE_CRON=1 → skip the tick (dev default)
 *   DISABLE_VAT_REVERIFY_EMAIL=1 → run the
 *     re-verify but don't send email (useful for
 *     soak-testing the verification logic without
 *     spamming real users)
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { VatValidationService } from './vat-validation.service'
// Tier 119: CronHealthService for the @Cron wrap.
import { CronHealthService } from '../admin/cron-health.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

// How stale (in days) a 'valid' check can be before
// we re-run it. VIES itself says VAT registrations
// can change at any time, but a 30-day window is
// the industry norm. The same constant lives in
// VatValidationService — we just re-state it here
// for the query filter.
const REVERIFY_AFTER_DAYS = 30

@Injectable()
export class VatReverifyScheduler {
  private readonly logger = new Logger(VatReverifyScheduler.name)

  /**
   * Dev-only trigger so we can verify the cron
   * wiring without waiting until 02:00. Bypasses
   * DISABLE_CRON. Returns the same stats the cron
   * logs at the end of a real run.
   */
  async runNowForTest(): Promise<{ customers: number; suppliers: number; transitions: number; errors: number }> {
    this.logger.warn('runNowForTest called — bypassing DISABLE_CRON')
    const today = new Date().toISOString().slice(0, 10)
    for (const k of this._emailedToday) {
      if (!k.endsWith(':' + today)) this._emailedToday.delete(k)
    }
    const cutoff = new Date(Date.now() - REVERIFY_AFTER_DAYS * 24 * 3600 * 1000)
    let stats = { customers: 0, suppliers: 0, transitions: 0, errors: 0 }
    try { stats.customers = await this.reverifyEntity('customer', cutoff, today) }
    catch (e: any) {
      this.logger.error(`Customer re-verify failed: ${e?.message || e}`)
      stats.errors++
    }
    try { stats.suppliers = await this.reverifyEntity('supplier', cutoff, today) }
    catch (e: any) {
      this.logger.error(`Supplier re-verify failed: ${e?.message || e}`)
      stats.errors++
    }
    this.logger.log(
      `Re-verify (test) done. customers=${stats.customers} suppliers=${stats.suppliers} transitions=${stats.transitions} errors=${stats.errors}`,
    )
    return stats
  }
  // Track which (company, entity) pairs we've
  // already emailed about THIS calendar day, so a
  // re-run of the cron (e.g. after a server
  // restart at 03:00) doesn't double-email.
  // The dedupe key is "companyId:YYYY-MM-DD" so
  // the next day's tick starts fresh.
  private _emailedToday: Set<string> = new Set()
  // Tracked here instead of in VatValidationService
  // so we don't mix "ad-hoc" and "scheduled"
  // notification state.

  constructor(
    private readonly prisma: PrismaService,
    private readonly vatValidation: VatValidationService,
    private readonly mail: MailService,
    // Tier 119: every cron tick records to the shared
    // CronHealthService for the admin dashboard.
    private readonly health: CronHealthService,
  ) {
    this.logger.log('VatReverifyScheduler CONSTRUCTOR ran (this means DI is wiring us up)')
  }

  @Cron('0 2 * * *', {
    name: 'vat-reverify-daily',
    timeZone: 'Europe/Berlin',
  })
  async dailyReverify() {
    if (process.env.DISABLE_CRON === '1') {
      this.logger.debug('Skipping (DISABLE_CRON=1)')
      return
    }
    return this.health.wrap('vat-reverify-daily', async () => {
    // Reset dedupe set at the start of the day
    const today = new Date().toISOString().slice(0, 10)
    // (We keep entries from today and drop yesterday.)
    for (const k of this._emailedToday) {
      if (!k.endsWith(':' + today)) this._emailedToday.delete(k)
    }

    const cutoff = new Date(Date.now() - REVERIFY_AFTER_DAYS * 24 * 3600 * 1000)
    this.logger.log(`Starting nightly VIES re-verify (cutoff ${cutoff.toISOString()})`)

    let stats = { customers: 0, suppliers: 0, transitions: 0, errors: 0 }
    try {
      stats.customers = await this.reverifyEntity('customer', cutoff, today)
    } catch (e: any) {
      this.logger.error(`Customer re-verify failed: ${e?.message || e}`)
      stats.errors++
    }
    try {
      stats.suppliers = await this.reverifyEntity('supplier', cutoff, today)
    } catch (e: any) {
      this.logger.error(`Supplier re-verify failed: ${e?.message || e}`)
      stats.errors++
    }
    this.logger.log(
      `Re-verify done. customers=${stats.customers} suppliers=${stats.suppliers} transitions=${stats.transitions} errors=${stats.errors}`,
    )
    return `customers=${stats.customers} suppliers=${stats.suppliers} transitions=${stats.transitions} errors=${stats.errors}`
    })
  }

  /**
   * Walk every customer/supplier with a VAT ID
   * whose last 'valid' check is older than
   * `cutoff`, re-validate, and notify on status
   * transition.
   *
   * Returns the count of rows processed (for the
   * scheduler log). Notifications are sent
   * synchronously — if the mail server is down,
   * we log and move on (don't fail the cron).
   */
  private async reverifyEntity(
    entityType: 'customer' | 'supplier',
    cutoff: Date,
    today: string,
  ): Promise<number> {
    // Step 1: find all entity rows that have a
    // non-empty VAT ID. We DON'T pre-filter by
    // last-check-date because:
    //   - The "valid" cache (30 days) is a SEPARATE
    //     concern. The entity might have a valid
    //     check from 5 days ago (cached) — we
    //     skip it.
    //   - The "invalid" / "unreachable" cache is
    //     always re-checked (see
    //     VatValidationService.cache policy).
    //   - Pre-filtering would be a second query
    //     that needs its own index.
    //   - validateAndLog already returns the cached
    //     result when applicable, so the cost of
    //     "checking a fresh entity" is ~1ms (DB
    //     lookup only, no VIES call).
    const rows = await (this.prisma as any)[entityType].findMany({
      where: { vatId: { not: null } },
      select: { id: true, companyId: true, vatId: true, name: true },
    })
    let transitions = 0
    for (const row of rows) {
      if (!row.vatId) continue
      try {
        const result = await this.vatValidation.validateAndLog(
          row.companyId,
          entityType,
          row.id,
          row.vatId,
        )
        // Determine "transition" by comparing the
        // new status to the previous log entry's
        // status. If different AND not "unreachable"
        // (transient), it's a real status change.
        const prev = await this.vatValidation.latestForEntity(
          row.companyId,
          entityType,
          row.id,
        )
        if (prev && prev.status !== result.status && result.status !== 'unreachable') {
          transitions++
          await this.notifyTransition(entityType, row, prev.status, result.status, today)
        }
      } catch (e: any) {
        // Per-row errors must NOT abort the loop.
        this.logger.warn(
          `Re-verify failed for ${entityType} ${row.id} (${row.vatId}): ${e?.message || e}`,
        )
      }
    }
    return rows.length
  }

  /**
   * Send a "your VAT status changed" email to the
   * company. Dedupe per (company, day) so a
   * mid-night server restart doesn't double-email.
   */
  private async notifyTransition(
    entityType: 'customer' | 'supplier',
    row: { id: string; companyId: string; vatId: string; name: string },
    prevStatus: string,
    newStatus: string,
    today: string,
  ): Promise<void> {
    if (process.env.DISABLE_VAT_REVERIFY_EMAIL === '1') return
    const dedupeKey = `${row.companyId}:${today}`
    if (this._emailedToday.has(dedupeKey)) {
      // Already sent at least one notification to
      // this company today — skip to avoid spam.
      // The user can see all transitions in the
      // audit log.
      return
    }
    const company = await this.prisma.company.findUnique({
      where: { id: row.companyId },
      select: { email: true, name: true },
    })
    if (!company?.email) return
    try {
      await this.mail.send(row.companyId, {
        to: company.email,
        subject: `[de-invoice] USt-ID-Status geändert: ${row.name}`,
        text:
          `Die USt-ID-Prüfung für ${entityType === 'customer' ? 'Kunde' : 'Lieferant'} ` +
          `"${row.name}" (${row.vatId}) hat sich geändert:\n\n` +
          `  Vorher: ${prevStatus}\n` +
          `  Jetzt:  ${newStatus}\n\n` +
          `Bitte prüfen Sie im de-invoice-Dashboard, ob weitere Maßnahmen erforderlich sind.\n\n` +
          `-- de-invoice (automatische Benachrichtigung)`,
      })
      this._emailedToday.add(dedupeKey)
    } catch (e: any) {
      this.logger.warn(
        `Notification email failed for company ${row.companyId}: ${e?.message || e}`,
      )
    }
  }
}
