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
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  SetMetadata,
  UseGuards,
} from "@nestjs/common"
import { Request } from "express"
import { Prisma } from "@prisma/client"
import { ErrorTrackingService } from "./error-tracking.service"
import { PrismaService } from "../../prisma/prisma.service"
import { HeaderAuthGuard } from "../../auth/header-auth.guard"
import { SoftAuthGuard } from "../../auth/soft-auth.guard"
import { RolesGuard } from "../../auth/roles.guard"
import { Require } from "../../auth/roles.decorator"
import { NotificationService } from "./notification.service"
import { ConfigService } from "@nestjs/config"

@Controller("system")
// No class-level guard — POST /errors is public (SoftAuthGuard),
// the rest use HeaderAuthGuard + RolesGuard per-method.
export class SystemController {
  constructor(
    private readonly tracker: ErrorTrackingService,
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Frontend posts unhandled errors here. Auth-optional
   * so login-page / register-page crashes (no
   * x-user-id available) still get captured.
   */
  @Post("errors")
  @SetMetadata("publicRoute", true)
  @UseGuards(SoftAuthGuard)
  async captureError(@Body() body: any, @Req() req: Request) {
    if (!body || typeof body.message !== "string") {
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
      context: {
        component: body.component,
        browser: body.browser,
        level: body.level,
        ...body.context,
      },
      fingerprint: body.fingerprint || undefined,
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

  @Post("errors/:id/resolve")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async resolve(@Req() req: Request, @Param("id") id: string) {
    const userId = (req as any).user?.id || "system"
    const event = await this.tracker.resolve(id, userId)
    return { ok: true, status: event.status }
  }

  @Post("errors/:id/mute")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async mute(@Param("id") id: string) {
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
  async resolveAll() {
    const result = await this.prisma.errorEvent.updateMany({
      where: { status: "open" },
      data: {
        status: "resolved",
        resolvedAt: new Date(),
      },
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
  async muteAll() {
    const result = await this.prisma.errorEvent.updateMany({
      where: { status: "open" },
      data: { status: "muted" },
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
  async testNotification() {
    // Construct a synthetic event so the
    // push pipeline runs the same code path
    // as a real capture. We don't persist
    // this to the DB — the test is a
    // notification-only smoke test.
    const now = new Date()
    return this.notify.pushErrorNotification({
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
    } as any)
  }
}
