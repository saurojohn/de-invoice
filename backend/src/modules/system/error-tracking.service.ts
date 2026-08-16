/**
 * Self-hosted Sentry-style error tracking.
 *
 * Captures unhandled backend exceptions (via the global
 * filter in system.filter.ts) and frontend errors (via
 * POST /api/v1/system/errors). Dedupes by fingerprint
 * (SHA-256 of source + message + first stack frame) so
 * the same error 50 times shows as 1 row with
 * occurrences=50, not 50 rows.
 *
 * Why not @sentry/node?
 *   - Adds ~1MB deps, 3 new env vars
 *   - PII leaves the server (browser, IP, user email)
 *   - Free tier is rate-limited to 5K events/month
 *   - For an internal tool used by 1-3 people, a single
 *     Postgres table + a dashboard view is plenty
 *
 * The "differential cost" of the simple approach: every
 * 5 min an admin should run the prune endpoint to delete
 * resolved/old events (we keep 30 days by default).
 * That beats paying Sentry to see the same 5 errors
 * that happened because someone's PDFKit stack ran out
 * of pages.
 */
import { Injectable, Logger } from "@nestjs/common"
import { PrismaService } from "../../prisma/prisma.service"
import { createHash } from "crypto"
import { NotificationService } from "./notification.service"

export type ErrorSource = "backend" | "frontend"
export type ErrorKind = "unhandled" | "boundary" | "manual" | "api"
export type ErrorStatus = "open" | "resolved" | "muted"

export interface CaptureInput {
  source: ErrorSource
  message: string
  stack?: string | null
  kind?: ErrorKind
  context?: Record<string, any> | null
  url?: string | null
  method?: string | null
  statusCode?: number | null
  userId?: string | null
  companyId?: string | null
  // Allow callers to override fingerprint (e.g. the
  // global filter passes a hash including the route
  // name so 5 different routes throwing the same DB
  // constraint error don't get deduped into 1 row).
  fingerprint?: string
}

const STACK_MAX_BYTES = 4096

@Injectable()
export class ErrorTrackingService {
  private readonly logger = new Logger(ErrorTrackingService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationService,
  ) {}

  /**
   * Capture an error event. Returns the resulting
   * ErrorEvent row (newly created or pre-existing
   * with `occurrences` incremented).
   */
  async capture(input: CaptureInput) {
    const stack = (input.stack || "").slice(0, STACK_MAX_BYTES)
    const fp =
      input.fingerprint ||
      this.fingerprint(input.source, input.message, stack)
    // Upsert by fingerprint. If an open row with the
    // same fingerprint already exists, increment
    // occurrences + update lastSeenAt. Otherwise
    // create a new row.
    // SQLite/Postgres: we can't do an atomic
    // "increment if exists, else insert" in one
    // statement, so we read first then write. The
    // race window is tiny (a few ms) and worst case
    // we get 2 rows for the same fingerprint — the
    // dashboard view collapses them.
    const existing = await this.prisma.errorEvent.findFirst({
      where: { fingerprint: fp, status: "open" },
      orderBy: { lastSeenAt: "desc" },
    })
    if (existing) {
      return this.prisma.errorEvent.update({
        where: { id: existing.id },
        data: {
          occurrences: existing.occurrences + 1,
          lastSeenAt: new Date(),
          // Refresh the latest message + stack so a
          // developer looking at the row sees the most
          // recent failure, not a 2-week-old one.
          message: input.message.slice(0, 4000),
          stack: stack || existing.stack,
        },
      })
    }
    try {
      const created = await this.prisma.errorEvent.create({
        data: {
          source: input.source,
          kind: input.kind ?? "unhandled",
          message: input.message.slice(0, 4000),
          stack: stack || null,
          context: input.context ?? undefined,
          fingerprint: fp,
          url: input.url ?? null,
          method: input.method ?? null,
          statusCode: input.statusCode ?? null,
          userId: input.userId ?? null,
          companyId: input.companyId ?? null,
        },
      })
      // Tier 197 — push a notification for the
      // newly-created open event. The push is
      // fire-and-forget; we don't await it
      // because the user-facing request that
      // triggered the capture shouldn't block
      // on Slack latency. The NotificationService
      // already catches its own errors.
      void this.notify.pushErrorNotification(created)
      return created
    } catch (err: any) {
      // Capture failures must never break the request
      // that triggered them. Log and swallow.
      this.logger.error(
        `Failed to persist ErrorEvent: ${err?.message ?? err}`,
      )
      return null
    }
  }

  /**
   * Compute a stable fingerprint for dedupe.
   * SHA-256 of (source + message + first stack frame).
   * Same error 50 times → same fingerprint → 1 row.
   */
  fingerprint(source: string, message: string, stack: string): string {
    const firstFrame = (stack || "").split("\n")[0]?.trim() || ""
    return createHash("sha256")
      .update(`${source}::${message}::${firstFrame}`)
      .digest("hex")
      .slice(0, 32)
  }

  /**
   * Mark an event resolved. Idempotent.
   */
  async resolve(id: string, resolvedBy: string) {
    return this.prisma.errorEvent.update({
      where: { id },
      data: {
        status: "resolved",
        resolvedAt: new Date(),
        resolvedBy,
      },
    })
  }

  async mute(id: string) {
    return this.prisma.errorEvent.update({
      where: { id },
      data: { status: "muted" },
    })
  }

  /**
   * Delete events older than `days` OR with status
   * in {resolved, muted}. Run nightly or on-demand.
   * Default retention: 30 days.
   */
  async prune(days = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const result = await this.prisma.errorEvent.deleteMany({
      where: {
        OR: [
          { lastSeenAt: { lt: cutoff } },
          { status: { in: ["resolved", "muted"] } },
        ],
      },
    })
    return { deleted: result.count }
  }
}
