/**
 * System endpoints — error tracking + health checks.
 *
 * Public:
 *   POST /api/v1/system/errors        log a frontend error
 *                                      (works pre-auth via SoftAuthGuard)
 *
 * Admin-only (header auth + @Require('users.read')):
 *   GET    /api/v1/system/errors              list (per-company)
 *   POST   /api/v1/system/errors/:id/resolve  mark resolved
 *   POST   /api/v1/system/errors/:id/mute     mark muted
 *   POST   /api/v1/system/errors/prune        delete old (>30d) + resolved
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  SetMetadata,
  UseGuards,
  NotFoundException,
} from "@nestjs/common"
import { Request } from "express"
import { Prisma } from "@prisma/client"
import { ErrorTrackingService } from "./error-tracking.service"
import { Throttle } from "@nestjs/throttler"
import { PrismaService } from "../../prisma/prisma.service"
import { AuditService } from "../audit/audit.service"
import { HeaderAuthGuard } from "../../auth/header-auth.guard"
import { SoftAuthGuard } from "../../auth/soft-auth.guard"
import { RolesGuard } from "../../auth/roles.guard"
import { Require } from "../../auth/roles.decorator"
import { NotificationService } from "./notification.service"
import { ConfigService } from "@nestjs/config"
import { Public } from "../../auth/public.decorator"
import { boundContext, CaptureErrorDto } from "./dto/capture-error.dto"

@Controller("system")
// No class-level guard — POST /errors is public (SoftAuthGuard),
// the rest use HeaderAuthGuard + RolesGuard per-method.
export class SystemController {
  constructor(
    private readonly tracker: ErrorTrackingService,
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Frontend posts unhandled errors here. Auth-optional
   * so login-page / register-page crashes (no
   * x-user-id available) still get captured.
   */
  @Public()
  @Post("errors")
  // Tier 392: public and unauthenticated — a tight per-IP limit (the global
  // default is 600/60s). A crashing page bursts a handful of errors; 60/min is
  // far more than a real client needs and bounds the row / notification flood.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @SetMetadata("publicRoute", true)
  @UseGuards(SoftAuthGuard)
  async captureError(@Body() body: CaptureErrorDto, @Req() req: Request) {
    if (!body?.message) {
      // Don't persist garbage — just 200 OK so the
      // frontend doesn't see a noisy 400 in devtools.
      return { ok: true, deduped: false }
    }
    const saved = await this.tracker.capture({
      source: "frontend",
      kind: body.kind || "unhandled",
      message: String(body.message).slice(0, 4000),
      stack: body.stack ? String(body.stack).slice(0, 4096) : null,
      url: body.url || (req.headers.referer as string) || null,
      method: null,
      statusCode: null,
      userId: (req as any).user?.id || null,
      companyId: (req as any).user?.companyId || null,
      // Tier 392: the context is bounded — an unauthenticated post stored a
      // 2 MB context verbatim (measured).
      context: boundContext({
        component: body.component,
        browser: body.browser,
        level: body.level,
        ...body.context,
      }),
      // Tier 392: the client's fingerprint is NOT used. It decided which group
      // a row joined, so an unauthenticated post could rewrite an existing
      // group's message and stack, or mint unlimited new groups (each firing an
      // operator notification). The service derives it from source + message +
      // first stack frame — what the frontend's own hash approximated.
    })
    return { ok: true, deduped: saved?.occurrences ?? 1 }
  }

  @Get("errors")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async listErrors(
    @Req() req: Request,
    @Query("status") status?: string,
    @Query("source") source?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const companyId = (req as any).user?.companyId
    const where: any = {}
    if (status) where.status = status
    if (source) where.source = source
    // Admin sees only their own company's errors.
    if (companyId) where.companyId = companyId
    const [items, total, openCount] = await Promise.all([
      this.prisma.errorEvent.findMany({
        where,
        orderBy: { lastSeenAt: "desc" },
        take: Math.min(parseInt(take || "50", 10) || 50, 200),
        skip: parseInt(skip || "0", 10) || 0,
      }),
      this.prisma.errorEvent.count({ where }),
      this.prisma.errorEvent.count({
        where: { ...where, status: "open" },
      }),
    ])
    return { items, total, openCount }
  }

  /**
   * Tier 200 — system-error timeline.
   *
   * Returns a per-day count of error
   * events for the last N days (default
   * 30). The frontend renders this as a
   * stacked bar chart (open / resolved /
   * muted) so the operator can spot
   * "errors are spiking this week" at a
   * glance.
   *
   * Bucketing is by `firstSeenAt` day in
   * the server's timezone (PG
   * `date_trunc('day', ...)`). Each
   * bucket shows the count by CURRENT
   * status — we don't keep a history
   * table, so a row that's been resolved
   * counts as "resolved" in its creation
   * day (not "open"). For the "is
   * anything spiking" use case that's
   * the right semantics: the operator
   * wants to see "how many open errors
   * are piling up this week", not "what
   * was open on Monday that's now
   * resolved".
   *
   * Why a separate endpoint, not just
   * richer `listErrors`?
   *   - Timeline fetches N days in one
   *     query; list fetches 200 rows
   *     (different shape).
   *   - Adding `groupBy`/raw SQL to
   *     listErrors would make that
   *     controller method slow when
   *     `take=200` AND we don't need the
   *     rows.
   *
   * Query:
   *   - days: 1..90 (default 30, capped
   *     at 90 to keep the query small)
   *   - source: 'backend' | 'frontend' |
   *     omitted for all
   *   - companyId: required (admin path)
   */
  @Get("errors/timeline")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async errorTimeline(
    @Query("days") daysStr?: string,
    @Query("source") source?: string,
    @Query("companyId") companyId?: string,
  ) {
    const days = Math.min(
      Math.max(parseInt(daysStr || "30", 10) || 30, 1),
      90,
    )
    // Use PG's date_trunc to bucket
    // by day in the server timezone.
    // The result is one row per
    // (day, status) — we then pivot
    // in JS to one row per day with
    // counts for each status.
    const cutoff = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    )
    const where: any = { firstSeenAt: { gte: cutoff } }
    if (source) where.source = source
    if (companyId) where.companyId = companyId
    // Per-day via $queryRaw for
    // date_trunc (Prisma groupBy doesn't
    // support date functions). The
    // source/companyId filters are
    // appended via Prisma.sql join so
    // the parameter binding stays safe
    // (no string concat — would be
    // SQL-injection risk).
    const conditions: any[] = [Prisma.sql`"firstSeenAt" >= ${cutoff}`]
    if (source) {
      conditions.push(Prisma.sql`source = ${source}`)
    }
    if (companyId) {
      conditions.push(Prisma.sql`"companyId" = ${companyId}`)
    }
    const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
    const buckets: Array<{
      date: string
      total: number
      open: number
      resolved: number
      muted: number
    }> = []
    const raw = await this.prisma.$queryRaw<
      Array<{ day: Date; status: string; cnt: bigint }>
    >`
      SELECT
        date_trunc('day', "firstSeenAt") as day,
        status,
        COUNT(*) as cnt
      FROM "ErrorEvent"
      ${whereClause}
      GROUP BY day, status
      ORDER BY day ASC
    `
    // Pivot into per-day buckets.
    const dayMap = new Map<
      string,
      { total: number; open: number; resolved: number; muted: number }
    >()
    for (const row of raw) {
      const dayKey = new Date(row.day).toISOString().slice(0, 10)
      const cur = dayMap.get(dayKey) || {
        total: 0,
        open: 0,
        resolved: 0,
        muted: 0,
      }
      const cnt = Number(row.cnt)
      cur.total += cnt
      if (row.status === "open") cur.open += cnt
      else if (row.status === "resolved") cur.resolved += cnt
      else if (row.status === "muted") cur.muted += cnt
      dayMap.set(dayKey, cur)
    }
    // Emit one bucket per day in the
    // window (even days with 0 events,
    // so the bar chart x-axis is
    // continuous). Loop from today
    // backwards N days.
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000)
      const key = d.toISOString().slice(0, 10)
      const cur = dayMap.get(key) || {
        total: 0,
        open: 0,
        resolved: 0,
        muted: 0,
      }
      buckets.push({ date: key, ...cur })
    }
    // Status-aggregated totals for
    // the header chips ("X open / Y
    // resolved / Z muted in the last
    // N days").
    const totals = {
      open: 0,
      resolved: 0,
      muted: 0,
    }
    for (const b of buckets) {
      totals.open += b.open
      totals.resolved += b.resolved
      totals.muted += b.muted
    }
    return {
      days,
      source: source || "all",
      buckets,
      totals,
    }
  }

  /**
   * Tier 206 — top-N fingerprints by
   * occurrence rate over the configured
   * window. The "rate" is the number of
   * distinct ErrorEvent rows for a
   * fingerprint where `lastSeenAt >= now -
   * windowMinutes`. The fingerprint index
   * (see ErrorEvent schema) makes this
   * query O(matches) not O(table).
   *
   * The response includes the
   * NotificationConfig threshold so the
   * UI can mark rows as "over threshold"
   * (= would trigger a push) or "below
   * threshold" (= would be suppressed
   * by the rate gate). This is the
   * missing piece from Tier 205: the
   * threshold is configurable, but the
   * operator had no way to see WHICH
   * fingerprints are approaching or
   * crossing the line.
   *
   * Query: `prisma.errorEvent.groupBy({
   * by: ['fingerprint'], where:
   * { lastSeenAt: { gte: cutoff } },
   * _count: { _all: true } })` — one
   * query, returns up to `limit` rows
   * sorted by count desc. We also need
   * the latest message for the
   * fingerprint so the UI can show
   * "what's actually firing" — we do a
   * 2nd query for the latest 50 events
   * in the window, then group in JS.
   *
   * Filters:
   *   - windowMinutes: 1..1440 (default
   *     = NotificationConfig window if
   *     available, else 60)
   *   - limit: 1..50 (default 10)
   *   - source: 'backend' | 'frontend'
   *     (optional)
   *
   * Same RBAC as the rest of the admin
   * surface (`users.read`).
   */
  @Get("errors/top-rate")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async topRateFingerprints(
    @Query("windowMinutes") windowMinutesStr?: string,
    @Query("limit") limitStr?: string,
    @Query("source") source?: string,
  ) {
    // Default the window to the
    // configured threshold window
    // (if available) so the UI shows
    // the same rate that the
    // NotificationService would
    // evaluate. If the threshold
    // table is empty, fall back to
    // 60 minutes.
    const threshold = await this.notify.getThreshold()
    const windowMinutes = Math.min(
      Math.max(
        parseInt(windowMinutesStr || String(threshold.windowMinutes), 10) ||
          threshold.windowMinutes,
        1,
      ),
      1440,
    )
    const limit = Math.min(
      Math.max(parseInt(limitStr || "10", 10) || 10, 1),
      50,
    )
    const cutoff = new Date(
      Date.now() - windowMinutes * 60 * 1000,
    )
    // Count rows per fingerprint in
    // the window. The fingerprint
    // index makes this O(matches).
    // We sort by count desc + take
    // `limit` to keep the response
    // small.
    const where: any = { lastSeenAt: { gte: cutoff } }
    if (source) where.source = source
    const grouped = await this.prisma.errorEvent.groupBy({
      by: ["fingerprint"],
      where,
      _count: { _all: true },
      // Tier 208 — MED-004. We tried
      // `orderBy: { _count: { _all: "desc" } }`
      // (the unambiguous "count of all rows
      // in the group" alias) but Prisma 5.22's
      // `ErrorEventCountOrderByAggregateInput`
      // type only allows model fields (id,
      // source, message, ...), not `_all`.
      // Sticking with the original
      // `fingerprint` form — Prisma accepts
      // it because `fingerprint` is in
      // `by: ["fingerprint"]` and orders by
      // the grouped-field's count. The audit
      // entry stays as a comment so the
      // future intent is recorded.
      orderBy: { _count: { fingerprint: "desc" } },
      take: limit,
    })
    // Fetch the latest event per
    // fingerprint so the UI can
    // show "what's actually firing".
    // 2nd query (top `limit`
    // fingerprints × 1 row each =
    // limit rows max).
    const fingerprints = grouped.map((g) => g.fingerprint)
    const latestRows = fingerprints.length
      ? await this.prisma.errorEvent.findMany({
          where: { fingerprint: { in: fingerprints } },
          orderBy: { lastSeenAt: "desc" },
          take: limit * 2, // extra headroom in case of same-fingerprint multiples
          select: {
            fingerprint: true,
            message: true,
            source: true,
            kind: true,
            lastSeenAt: true,
            occurrences: true,
            status: true,
          },
        })
      : []
    // For each fingerprint, pick
    // the row with the latest
    // lastSeenAt. The rows we got
    // are already ordered by
    // lastSeenAt desc, so the
    // first row per fingerprint
    // wins.
    const latestByFp = new Map<string, any>()
    for (const row of latestRows) {
      if (!latestByFp.has(row.fingerprint)) {
        latestByFp.set(row.fingerprint, row)
      }
    }
    const rows = grouped.map((g) => {
      const latest = latestByFp.get(g.fingerprint)
      const count = g._count._all
      return {
        fingerprint: g.fingerprint,
        // short hash prefix for
        // the UI (full hash is
        // 64 chars of hex)
        fingerprintShort: g.fingerprint.slice(0, 12),
        count,
        // Tier 205 — the same
        // threshold the gate
        // uses. Mark `exceeded`
        // so the UI can render
        // a red badge.
        threshold: threshold.count,
        exceeded: count >= threshold.count,
        message: latest?.message ?? null,
        source: latest?.source ?? null,
        kind: latest?.kind ?? null,
        status: latest?.status ?? null,
        lastSeenAt: latest?.lastSeenAt ?? null,
        occurrences: latest?.occurrences ?? count,
      }
    })
    return {
      windowMinutes,
      threshold: threshold.count,
      limit,
      source: source || "all",
      rows,
    }
  }

  /**
   * Tier 378: resolve / mute acted on any ErrorEvent id — tenant B muted and
   * resolved company A's error (measured). Same scope as GET /system/errors:
   * the caller's company. Platform-wide rows (companyId NULL) are not a
   * tenant's to change; see HANDOFF (platform admin).
   */
  private async assertOwnError(req: Request, id: string) {
    const companyId = (req as any).user?.companyId
    const row = companyId
      ? await this.prisma.errorEvent.findFirst({ where: { id, companyId }, select: { id: true } })
      : null
    if (!row) throw new NotFoundException("Fehlereintrag nicht gefunden")
  }

  @Post("errors/:id/resolve")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async resolve(@Req() req: Request, @Param("id") id: string) {
    const userId = (req as any).user?.id || "system"
    await this.assertOwnError(req, id)
    const event = await this.tracker.resolve(id, userId)
    return { ok: true, status: event.status }
  }

  @Post("errors/:id/mute")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async mute(@Req() req: Request, @Param("id") id: string) {
    await this.assertOwnError(req, id)
    const event = await this.tracker.mute(id)
    return { ok: true, status: event.status }
  }

  @Post("errors/prune")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async prune() {
    const result = await this.tracker.prune(30)
    return { ok: true, ...result }
  }

  // ─── Tier 197 — bulk operations ──────────────

  /**
   * Bulk-resolve every open error. Used by the
   * "Resolve all open" button on the system-errors
   * page after the operator has triaged. We don't
   * filter by fingerprint — this is the "clear
   * the inbox" gesture.
   */
  @Post("errors/resolve-all")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async resolveAll(@Req() req: Request) {
    const userId = (req as any).user?.id || null
    const result = await this.prisma.errorEvent.updateMany({
      where: { status: "open" },
      data: {
        status: "resolved",
        resolvedAt: new Date(),
      },
    })
    // Tier 202 — log the operator
    // action in the activity log
    // (hash-chained with the rest
    // of the audit trail).
    await this.audit.writeActivity({
      companyId: (req as any).user?.companyId || null,
      userId,
      action: "error.resolve_all",
      entityType: "ErrorEvent",
      metadata: { count: result.count },
    })
    return { ok: true, count: result.count }
  }

  /**
   * Bulk-mute every open error. Use when the
   * operator knows the errors are noise (e.g. a
   * known third-party API outage) and doesn't want
   * the next operator's inbox to be full.
   */
  @Post("errors/mute-all")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async muteAll(@Req() req: Request) {
    const userId = (req as any).user?.id || null
    const result = await this.prisma.errorEvent.updateMany({
      where: { status: "open" },
      data: { status: "muted" },
    })
    // Tier 202 — log the operator
    // action.
    await this.audit.writeActivity({
      companyId: (req as any).user?.companyId || null,
      userId,
      action: "error.mute_all",
      entityType: "ErrorEvent",
      metadata: { count: result.count },
    })
    return { ok: true, count: result.count }
  }

  /**
   * Tier 197 — read the current notification
   * channel configuration. Returns whether
   * Slack / email are configured, without
   * exposing the webhook URL or SMTP password
   * (we surface only the host + a boolean).
   */
  @Get("notifications/config")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  notificationsConfig() {
    const slackUrl = this.config.get<string>("SLACK_WEBHOOK_URL")
    const emailList = this.config.get<string>("NOTIFY_EMAIL")
    const smtpHost = this.config.get<string>("SMTP_HOST")
    return {
      slack: {
        configured: !!slackUrl,
        // Don't echo the URL — it contains a secret
        // token. The operator can edit the .env
        // directly to verify the value.
        host: slackUrl ? new URL(slackUrl).host : null,
      },
      email: {
        configured: !!emailList,
        recipients: emailList
          ? emailList.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
        smtpHost: smtpHost || null,
      },
      antiSpamMinutes: 5,
    }
  }

  /**
   * Tier 197 — fire a test notification through
   * the same code path as a real error event,
   * so the operator can verify Slack / email
   * wiring without waiting for a real error.
   * Returns the per-channel result (sent /
   * skipped / failed).
   */
  @Post("notifications/test")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async testNotification(@Req() req: Request) {
    // Construct a synthetic event so the
    // push pipeline runs the same code path
    // as a real capture. We don't persist
    // this to the DB — the test is a
    // notification-only smoke test.
    const userId = (req as any).user?.id || null
    const companyId = (req as any).user?.companyId || null
    // Tier 202 — log the action.
    await this.audit.writeActivity({
      companyId,
      userId,
      action: "notification.test",
      entityType: "Notification",
      metadata: { source: "system/notifications/test" },
    })
    const now = new Date()
    // Tier 205 — `force: true` bypasses the
    // rate-threshold gate so the operator can
    // test the wiring without having to spam
    // 5 errors first. The test message is
    // clearly marked [Tier 197 test] in the
    // payload, so Slack recipients know it's
    // a manual smoke test.
    return this.notify.pushErrorNotification(
      {
      id: "test-notification",
      source: "backend",
      kind: "manual",
      message:
        "[Tier 197 test] This is a synthetic notification fired from /api/v1/system/notifications/test. " +
        "If you see this in Slack / email, the wiring works.",
      stack: null,
      context: { test: true },
      fingerprint: "tier197-test-" + now.getTime(),
      url: null,
      method: "POST",
      statusCode: null,
      userId: null,
      companyId: null,
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      mutedAt: null,
      createdAt: now,
    } as any,
      { force: true },
    )
  }

  /**
   * Tier 205 — read the current rate
   * threshold. Returns the singleton
   * `NotificationConfig` row, or sensible
   * defaults if the table is empty (fresh
   * deploy, pre-seed).
   *
   * The threshold is read by the
   * `NotificationService` hot path so
   * it can be cached for 60s. This
   * endpoint is admin-only — exposing
   * the threshold to a tenant would
   * let them DoS the operator's Slack
   * by setting a low rate + spamming
   * errors.
   */
  @Get("notifications/threshold")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async getNotificationThreshold() {
    const t = await this.notify.getThreshold()
    return {
      rateThresholdCount: t.count,
      rateThresholdWindowMinutes: t.windowMinutes,
    }
  }

  /**
   * Tier 205 — update the rate threshold.
   * The push channels (Slack/email) only
   * fire when a fingerprint crosses
   * `rateThresholdCount` occurrences within
   * `rateThresholdWindowMinutes` minutes.
   * Default 5/60 (= "5 in an hour") so a
   * one-off doesn't wake anyone up at 3am,
   * but a real flood does.
   *
   * Validation:
   *   - count: 1..1000 (1 = "always notify",
   *     1000 = effectively never)
   *   - windowMinutes: 1..1440 (1 min .. 24h)
   *
   * The change is written to the DB (so it
   * survives a restart), the in-memory cache
   * is refreshed (so the next push check
   * uses the new value), and an activity log
   * row is written (so the Berater can audit
   * who lowered the threshold and why).
   */
  @Put("notifications/threshold")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async setNotificationThreshold(
    @Req() req: Request,
    @Body()
    body: {
      rateThresholdCount?: number
      rateThresholdWindowMinutes?: number
      note?: string
    },
  ) {
    if (
      body.rateThresholdCount === undefined &&
      body.rateThresholdWindowMinutes === undefined
    ) {
      throw new BadRequestException(
        "rateThresholdCount oder rateThresholdWindowMinutes ist erforderlich",
      )
    }
    if (
      body.rateThresholdCount !== undefined &&
      (body.rateThresholdCount < 1 || body.rateThresholdCount > 1000)
    ) {
      throw new BadRequestException(
        "rateThresholdCount muss zwischen 1 und 1000 liegen",
      )
    }
    if (
      body.rateThresholdWindowMinutes !== undefined &&
      (body.rateThresholdWindowMinutes < 1 ||
        body.rateThresholdWindowMinutes > 1440)
    ) {
      throw new BadRequestException(
        "rateThresholdWindowMinutes muss zwischen 1 und 1440 liegen (1 min .. 24h)",
      )
    }
    // Upsert the singleton row. The schema
    // doesn't have a unique constraint on
    // anything (it's a true singleton by
    // convention), so we read the existing
    // row, update it, or create one if
    // missing.
    const existing = await this.prisma.notificationConfig.findFirst({
      orderBy: { updatedAt: "desc" },
    })
    const data: Prisma.NotificationConfigUpdateInput = {
      ...(body.rateThresholdCount !== undefined
        ? { rateThresholdCount: body.rateThresholdCount }
        : {}),
      ...(body.rateThresholdWindowMinutes !== undefined
        ? { rateThresholdWindowMinutes: body.rateThresholdWindowMinutes }
        : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    }
    let row
    if (existing) {
      row = await this.prisma.notificationConfig.update({
        where: { id: existing.id },
        data,
      })
    } else {
      row = await this.prisma.notificationConfig.create({
        data: {
          rateThresholdCount: body.rateThresholdCount ?? 5,
          rateThresholdWindowMinutes: body.rateThresholdWindowMinutes ?? 60,
          note: body.note ?? null,
        },
      })
    }
    // Refresh the in-memory cache so the
    // next push check uses the new value
    // without waiting for the 60s TTL.
    this.notify.setThreshold({
      count: row.rateThresholdCount,
      windowMinutes: row.rateThresholdWindowMinutes,
    })
    // Tier 202 — log the action. The
    // metadata blob carries the old + new
    // values so the Berater can see what
    // changed and when.
    const userId = (req as any).user?.id || null
    const companyId = (req as any).user?.companyId || null
    await this.audit.writeActivity({
      companyId,
      userId,
      action: "notification.threshold_set",
      entityType: "NotificationConfig",
      entityId: row.id,
      metadata: {
        rateThresholdCount: row.rateThresholdCount,
        rateThresholdWindowMinutes: row.rateThresholdWindowMinutes,
        note: row.note,
      },
    })
    return {
      rateThresholdCount: row.rateThresholdCount,
      rateThresholdWindowMinutes: row.rateThresholdWindowMinutes,
      note: row.note,
      updatedAt: row.updatedAt,
    }
  }
}
