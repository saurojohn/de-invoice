/**
 * NotificationService — Tier 197 push-channel surface.
 *
 * Goal: when a new error lands in ErrorEvent (open
 * status, threshold-level severity), push a one-liner
 * to wherever the operator is looking. Three
 * channels, all optional, configured via env:
 *
 *   1. SLACK_WEBHOOK_URL  →  POST a JSON payload to
 *      the Slack incoming-webhook URL. We don't use
 *      the full Slack Block Kit — a plain text
 *      message with a link back to the dashboard is
 *      enough for an on-call glance.
 *   2. NOTIFY_EMAIL       →  send an email via the
 *      existing MailService (SMTP). Comma-separated
 *      list of recipients. Only fires for the
 *      first occurrence of a fingerprint in a
 *      5-minute window (anti-spam).
 *   3. (fallback) console →  always log to the
 *      NestJS logger, even when no external
 *      channel is configured. Operators can grep
 *      the log even when the dashboard is down.
 *
 * The service is intentionally additive: capture()
 * never throws (errors here would lose the original
 * error event, which is worse than missing a
 * notification). If Slack returns 4xx / 5xx we
 * log the failure and continue.
 *
 * Why not Alertmanager / PagerDuty / Opsgenie?
 *   - Alertmanager is wired into Prometheus (Tier 193)
 *     and only fires on metrics thresholds, not on
 *     per-error fingerprint events. Different problem.
 *   - PagerDuty / Opsgenie add a third-party
 *     dependency for a problem a Slack webhook
 *     solves in 20 lines of code.
 *   - The Berater / operator pool for de-invoice
 *     is 1-3 people; a Slack #ops-de-invoice channel
 *     is the right scale.
 */
import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { ErrorEvent } from "@prisma/client"
import { PrismaService } from "../../prisma/prisma.service"

/**
 * Tier 205 — return shape for the
 * `getThreshold()` reader. The service
 * keeps a cached copy in memory (refreshed
 * every 60s) so the hot-path push check
 * doesn't hit the DB on every error.
 */
export interface NotificationThreshold {
  count: number
  windowMinutes: number
}

interface PushResult {
  slack: "sent" | "skipped" | "failed"
  email: "sent" | "skipped" | "failed"
  console: "sent"
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name)
  // In-memory anti-spam cache: fingerprint -> last
  // pushed timestamp. We dedupe notifications on
  // a per-fingerprint basis so a flood of the
  // same error doesn't spam Slack. 5-minute window
  // is short enough that genuine re-occurrences
  // (e.g. a deploy that fixed a root cause but
  // left a residual) still get through.
  private readonly recentPushes = new Map<string, number>()
  private static readonly ANTI_SPAM_MS = 5 * 60 * 1000
  // Tier 205 — rate-threshold cache. Refreshed
  // every 60s by the hot-path check below; the
  // controller mutates the cache directly on
  // PUT so the new threshold takes effect
  // without waiting for the next refresh.
  private thresholdCache: NotificationThreshold = {
    count: 5,
    windowMinutes: 60,
  }
  private thresholdLoadedAt = 0
  private static readonly THRESHOLD_TTL_MS = 60 * 1000

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Tier 205 — read the current rate threshold
   * from the DB (cached for 60s). The hot-path
   * push check uses this to decide whether the
   * fingerprint has crossed the "noisy enough to
   * notify" line. The first call after process
   * start hits the DB; subsequent calls return
   * the cached value until the TTL expires.
   *
   * Returns the singleton row from
   * NotificationConfig, or a sensible default
   * if the table is empty (the very first push
   * after a fresh deploy seeds the row lazily on
   * the first PUT, not here).
   */
  async getThreshold(): Promise<NotificationThreshold> {
    const now = Date.now()
    if (now - this.thresholdLoadedAt < NotificationService.THRESHOLD_TTL_MS) {
      return this.thresholdCache
    }
    try {
      // `findFirst` because the table is a
      // singleton (no companyId, no unique
      // constraint). Cheap with one row max.
      const row = await this.prisma.notificationConfig.findFirst({
        orderBy: { updatedAt: "desc" },
        select: {
          rateThresholdCount: true,
          rateThresholdWindowMinutes: true,
        },
      })
      if (row) {
        this.thresholdCache = {
          count: row.rateThresholdCount,
          windowMinutes: row.rateThresholdWindowMinutes,
        }
      }
      this.thresholdLoadedAt = now
    } catch (e: any) {
      // If the table doesn't exist yet
      // (fresh deploy, pre-migration) the
      // push check still works — we just
      // use the in-memory defaults. Log
      // the error so the operator knows
      // their config isn't taking effect.
      this.logger.warn(
        `[tier205/threshold] failed to load: ${e?.message || String(e)} — using defaults`,
      )
    }
    return this.thresholdCache
  }

  /**
   * Tier 205 — set the rate threshold and
   * refresh the cache immediately so the
   * next push check uses the new value
   * without waiting for the TTL.
   */
  setThreshold(t: NotificationThreshold): void {
    this.thresholdCache = { ...t }
    this.thresholdLoadedAt = Date.now()
  }

  /**
   * Tier 205 — check the fingerprint's rate
   * over the configured window. Returns the
   * count (so the caller can log it) and a
   * boolean indicating whether the rate has
   * crossed the threshold. This is the gate
   * that determines whether the push fires
   * AT ALL — anti-spam is a separate throttle
   * (the same fingerprint can't fire twice
   * in 5 min). Rate threshold and anti-spam
   * serve different purposes: rate threshold
   * = "is this noisy enough to wake someone
   * up?", anti-spam = "we just sent one 30
   * seconds ago, don't double-tap".
   */
  private async isRateExceeded(
    fingerprint: string,
    threshold: NotificationThreshold,
  ): Promise<{ count: number; exceeded: boolean }> {
    const cutoff = new Date(
      Date.now() - threshold.windowMinutes * 60 * 1000,
    )
    // Count rows for this fingerprint in
    // the window. The fingerprint is indexed
    // (see ErrorEvent schema) so the query is
    // O(matches) not O(table).
    const count = await this.prisma.errorEvent.count({
      where: {
        fingerprint,
        lastSeenAt: { gte: cutoff },
      },
    })
    return {
      count,
      exceeded: count >= threshold.count,
    }
  }

  /**
   * Push a notification for a new open error event.
   * Never throws — failures are logged and the
   * original capture() result is unaffected.
   *
   * The payload includes:
   *   - error message (truncated to 200 chars for
   *     Slack readability)
   *   - source (backend | frontend)
   *   - kind (unhandled | boundary | manual | api)
   *   - occurrences + firstSeenAt + lastSeenAt
   *   - a deep link back to the dashboard
   *     (/dashboard/system-errors?fingerprint=...)
   *     so the on-call can click straight through.
   *
   * @param event the error event (real or synthetic)
   * @param opts.force skip the rate-threshold gate
   *   (used by the manual test-notification endpoint
   *   so the operator can verify the wiring without
   *   having to spam 5 errors first)
   */
  async pushErrorNotification(
    event: ErrorEvent,
    opts: { force?: boolean } = {},
  ): Promise<PushResult> {
    const result: PushResult = {
      slack: "skipped",
      email: "skipped",
      console: "sent",
    }
    // Console is always on. Operators can grep
    // /tmp/backend.log for "tier197/notify" to
    // see all error pushes regardless of which
    // external channels are configured.
    this.logger.warn(
      `[tier197/notify] ${event.source}/${event.kind} ` +
      `(${event.occurrences}x) ${event.message.slice(0, 200)} ` +
      `— /dashboard/system-errors?fingerprint=${event.fingerprint}`,
    )
    // Tier 205 — rate-threshold gate. We check
    // the fingerprint's occurrences over the
    // configured window BEFORE the anti-spam
    // check so the operator can see in the
    // console log when a notification is being
    // suppressed by the rate gate (vs anti-
    // spam). If below threshold, we return
    // early — the push channels (Slack/email)
    // don't fire. `opts.force` (test endpoint)
    // bypasses the gate.
    if (!opts.force) {
      const threshold = await this.getThreshold()
      const rate = await this.isRateExceeded(event.fingerprint, threshold)
      if (!rate.exceeded) {
        this.logger.debug(
          `[tier205/rate] suppressed (rate ${rate.count}/${threshold.count} in ${threshold.windowMinutes}m) for fingerprint ${event.fingerprint.slice(0, 12)}…`,
        )
        return result
      }
    }
    if (this.isSpam(event.fingerprint)) {
      this.logger.debug(
        `[tier197/notify] suppressed (anti-spam) for fingerprint ${event.fingerprint.slice(0, 12)}…`,
      )
      return result
    }
    // Slack channel
    const slackUrl = this.config.get<string>("SLACK_WEBHOOK_URL")
    if (slackUrl) {
      try {
        await this.postToSlack(slackUrl, event)
        result.slack = "sent"
      } catch (e: any) {
        this.logger.error(
          `[tier197/notify] Slack post failed: ${e?.message || String(e)}`,
        )
        result.slack = "failed"
      }
    }
    // Email channel — we use the existing
    // MailService (dynamic import to avoid a
    // circular dep with the mail module).
    const emailList = this.config.get<string>("NOTIFY_EMAIL")
    if (emailList) {
      try {
        const { MailService } = await import("../mail/mail.service")
        const mail = new MailService(this.prisma)
        const recipients = emailList
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        // Tier 197 — email notifications don't
        // belong to any specific company. We pass
        // an empty companyId so MailService falls
        // through to the global SMTP config (the
        // env-var driven one). If the operator
        // wants per-company routing they can add
        // a NotificationConfig table later.
        const companyId = event.companyId || ""
        await mail.send(companyId, {
          to: recipients.join(", "),
          subject: `[de-invoice] ${event.source} error: ${event.message.slice(0, 80)}`,
          text:
            `Source: ${event.source}/${event.kind}\n` +
            `Occurrences: ${event.occurrences}\n` +
            `First seen: ${event.firstSeenAt.toISOString()}\n` +
            `Last seen: ${event.lastSeenAt.toISOString()}\n\n` +
            `Message:\n${event.message}\n\n` +
            `Open: /dashboard/system-errors?fingerprint=${event.fingerprint}`,
        })
        result.email = "sent"
      } catch (e: any) {
        this.logger.error(
          `[tier197/notify] email send failed: ${e?.message || String(e)}`,
        )
        result.email = "failed"
      }
    }
    return result
  }

  private isSpam(fingerprint: string): boolean {
    const now = Date.now()
    const last = this.recentPushes.get(fingerprint)
    if (last !== undefined && now - last < NotificationService.ANTI_SPAM_MS) {
      return true
    }
    this.recentPushes.set(fingerprint, now)
    // Light GC: drop entries older than the
    // anti-spam window. With 100 fingerprints
    // active this map is tiny (~few KB); the
    // cleanup is mainly hygiene.
    for (const [fp, ts] of this.recentPushes) {
      if (now - ts > NotificationService.ANTI_SPAM_MS) {
        this.recentPushes.delete(fp)
      }
    }
    return false
  }

  private async postToSlack(url: string, event: ErrorEvent): Promise<void> {
    const payload = {
      text:
        `🚨 *de-invoice ${event.source} error* ` +
        `(${event.kind}, ${event.occurrences}x)\n` +
        `>${event.message.slice(0, 200)}\n` +
        `Open: /dashboard/system-errors?fingerprint=${event.fingerprint}`,
    }
    // 5-second timeout. Slack is normally <500ms
    // but we cap the wait so a slow Slack
    // doesn't tie up the request thread.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        throw new Error(`Slack returned ${res.status}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
