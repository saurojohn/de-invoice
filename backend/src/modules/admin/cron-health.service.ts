/**
 * CronHealthService — Tier 119 system health monitoring.
 *
 * Each of the 8 background crons (webhook-retry,
 * fints-sync, reminder-auto-send, vat-reverify,
 * exchange-rate-refresh, afa-auto-booker,
 * recurring-invoices, daily-auto-backup) calls
 * `record()` after every run. The admin UI reads
 * `list()` to show the latest status of every cron.
 *
 * Why a service (not just SQL)?
 *   - Single source of truth for the schema
 *     (truncate error messages, normalise status
 *     to a small enum, default the startedAt to now).
 *   - The wrappers in the 8 schedulers stay
 *     one-liners: `try { ... } catch (e) { record(name,
 *     'failed', e); throw }` — the alternative (raw
 *     Prisma writes in each scheduler) would have
 *     duplicated the same try/finally logic 8 times.
 *   - `list()` joins the latest row per cron in a
 *     single query (raw SQL via $queryRaw is faster
 *     than 8 Prisma findFirst calls when the table
 *     grows).
 *
 * The `expected` map is a hand-curated registry of
 * every cron name + its schedule. We expose this
 * to the UI so the admin sees "next run in 3h 12m"
 * even if a cron has never fired (e.g. fresh DB).
 */
import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { SchedulerRegistry } from '@nestjs/schedule'
import { PrismaService } from '../../prisma/prisma.service'

export type CronStatus = 'success' | 'failed' | 'skipped'

export interface CronHealthRow {
  name: string
  /** CronExpression — see @Cron() decorator in each scheduler */
  schedule: string
  /** Europe/Berlin timezone name (or 'UTC' if not set) */
  timeZone: string
  /** 'success' | 'failed' | 'skipped' | null (never run) */
  status: CronStatus | null
  /** Last run startedAt (null if never run) */
  lastRunAt: Date | null
  /** Duration of the last run in ms (null if never run) */
  lastDurationMs: number | null
  /** Free-text error message from the last failed run */
  lastError: string | null
  /** Free-text summary ("processed 42 templates...") */
  lastSummary: string | null
  /** Best-effort estimate of the next run time. Computed
   *  by the service from the schedule + last run; the
   *  exact cron-parser evaluation is more involved and
   *  the UI only needs a rough "next run in 3h" label. */
  nextRunAt: Date | null
  /** 'green' if last run succeeded, 'red' if failed,
   *  'amber' if last run was >2× the schedule interval
   *  ago (cron looks stuck), 'grey' if never run. */
  health: 'green' | 'red' | 'amber' | 'grey'
}

@Injectable()
export class CronHealthService {
  private readonly logger = new Logger(CronHealthService.name)

  constructor(
    private prisma: PrismaService,
    private schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * Curated registry. Add a row here whenever a new
   * @Cron is added. The list() endpoint joins this
   * with the most recent CronHealth row to produce
   * the admin dashboard.
   *
   * `intervalMinutes` lets us compute the
   * "cron looks stuck" amber threshold (2 × interval)
   * without parsing the cron expression.
   */
  private static readonly EXPECTED: Array<{
    name: string
    schedule: string
    timeZone: string
    intervalMinutes: number
  }> = [
    { name: 'webhook-retry-worker', schedule: '* * * * *', timeZone: 'UTC', intervalMinutes: 1 },
    { name: 'fints-sync', schedule: '0 */4 * * *', timeZone: 'Europe/Berlin', intervalMinutes: 240 },
    { name: 'reminder-auto-send', schedule: '0 9 * * *', timeZone: 'Europe/Berlin', intervalMinutes: 1440 },
    { name: 'vat-reverify-daily', schedule: '0 2 * * *', timeZone: 'Europe/Berlin', intervalMinutes: 1440 },
    { name: 'exchange-rate-refresh', schedule: '0 2 * * *', timeZone: 'Europe/Berlin', intervalMinutes: 1440 },
    { name: 'afa-auto-booker', schedule: '5 0 1 * *', timeZone: 'Europe/Berlin', intervalMinutes: 43200 },
    { name: 'recurring-invoices-daily', schedule: '0 6 * * *', timeZone: 'Europe/Berlin', intervalMinutes: 1440 },
    { name: 'daily-auto-backup', schedule: '0 4 * * *', timeZone: 'Europe/Berlin', intervalMinutes: 1440 },
    // Tier 403: drops session rows older than SESSION_RETENTION_DAYS.
    { name: 'session-cleanup', schedule: '30 3 * * *', timeZone: 'Europe/Berlin', intervalMinutes: 1440 },
  ]

  /**
   * Wrap a scheduler method. Captures startedAt,
   * duration, status, and error. Returns the
   * wrapped function's return value unchanged so
   * the schedulers stay readable.
   *
   * Usage:
   *   @Cron('0 6 * * *', { name: 'recurring-daily', timeZone: 'Europe/Berlin' })
   *   async dailyTick() {
   *     return this.health.wrap('recurring-daily', async () => {
   *       // existing body
   *     })
   *   }
   *
   * The wrap is async-aware: it captures the
   * resolved value of the body and returns it. The
   * cron is also allowed to return a plain value
   * (e.g. a count).
   */
  async wrap<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now()
    try {
      const result = await fn()
      const duration = Date.now() - t0
      // Truncate the summary to a small string so the
      // table doesn't bloat. Most crons return a count
      // or a short status message; full result is
      // already in the scheduler's logger.
      const summary =
        typeof result === 'number'
          ? `processed ${result}`
          : typeof result === 'string'
          ? result.slice(0, 200)
          : result && typeof result === 'object' && 'summary' in result
          ? String((result as any).summary).slice(0, 200)
          : null
      await this.record(name, 'success', undefined, duration, summary)
      return result
    } catch (e: any) {
      const duration = Date.now() - t0
      await this.record(name, 'failed', e?.message || String(e), duration)
      throw e
    }
  }

  /**
   * Record a cron run. Most callers use `wrap()`
   * (above) but manual triggers (e.g. a CLI
   * `kick <name>` command in the future) can call
   * this directly.
   *
   * The error message is truncated to 1000 chars so
   * a stack trace from one misbehaving cron can't
   * bloat the table indefinitely. The full stack
   * trace is already in the NestJS logger.
   */
  async record(
    name: string,
    status: CronStatus,
    errorMessage?: string,
    durationMs?: number,
    summary?: string | null,
  ): Promise<void> {
    try {
      await this.prisma.cronHealth.create({
        data: {
          name,
          status,
          errorMessage: errorMessage ? errorMessage.slice(0, 1000) : null,
          durationMs: durationMs ?? null,
          summary: summary ? summary.slice(0, 200) : null,
        },
      })
    } catch (e: any) {
      // Never let the health write itself break the
      // scheduler. If the DB is having a bad day, we
      // log + swallow — the next run will retry the
      // record.
      this.logger.warn(
        `CronHealth record(${name}, ${status}) failed: ${e?.message}`,
      )
    }
  }

  /**
   * List every known cron + its most-recent health
   * row. Joins the EXPECTED registry with the latest
   * CronHealth row per name.
   *
   * The health colour is derived:
   *   - 'grey'  if the cron has never run
   *   - 'red'   if the last run failed
   *   - 'amber' if the last run was > 2 × interval ago
   *             (cron looks stuck)
   *   - 'green' otherwise
   *
   * `nextRunAt` is a best-effort estimate. We don't
   * run a full cron-parser; we approximate as
   * `lastRunAt + interval` (good enough for the
   * "next run in 3h 12m" label).
   */
  async list(): Promise<CronHealthRow[]> {
    // Pull the latest row per name. One query, one
    // round-trip. The DISTINCT ON is Postgres-specific
    // but matches the project's de-invoice stack.
    const latest = await this.prisma.$queryRaw<
      Array<{
        name: string
        status: CronStatus
        startedAt: Date
        durationMs: number | null
        errorMessage: string | null
        summary: string | null
      }>
    >`
      SELECT DISTINCT ON (name)
        name, status, "startedAt", "durationMs", "errorMessage", summary
      FROM "CronHealth"
      ORDER BY name, "startedAt" DESC
    `

    const byName = new Map(latest.map((r) => [r.name, r]))
    const now = Date.now()

    return CronHealthService.EXPECTED.map((exp) => {
      const last = byName.get(exp.name)
      const lastRunAt = last?.startedAt ?? null
      const intervalMs = exp.intervalMinutes * 60_000
      const nextRunAt = lastRunAt
        ? new Date(lastRunAt.getTime() + intervalMs)
        : null
      const health: CronHealthRow['health'] = !last
        ? 'grey'
        : last.status === 'failed'
        ? 'red'
        : now - (lastRunAt?.getTime() ?? 0) > intervalMs * 2
        ? 'amber'
        : 'green'
      return {
        name: exp.name,
        schedule: exp.schedule,
        timeZone: exp.timeZone,
        status: last?.status ?? null,
        lastRunAt,
        lastDurationMs: last?.durationMs ?? null,
        lastError: last?.errorMessage ?? null,
        lastSummary: last?.summary ?? null,
        nextRunAt,
        health,
      }
    })
  }

  /**
   * One-shot cleanup: delete CronHealth rows older
   * than `retentionDays`. Wired to a nightly @Cron
   * in cron-health.scheduler.ts so the table doesn't
   * grow unbounded.
   */
  async cleanOld(retentionDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const { count } = await this.prisma.cronHealth.deleteMany({
      where: { startedAt: { lt: cutoff } },
    })
    return count
  }

  /**
   * Tier 124: per-cron history (newest-first) with
   * optional status filter. Returns the most recent
   * `limit` runs for one cron, paginated by `skip`
   * (so the UI can load more on scroll).
   *
   * The total count is returned in a separate
   * parallel query so the UI can show "X of N
   * runs" and a "load more" button without an
   * extra round-trip.
   *
   * `status` is optional — when set, the WHERE
   * clause filters to that exact status (the UI
   * uses this to show only failed runs for
   * debugging). When null, all statuses are
   * returned.
   *
   * The shape mirrors CronHealthRow's per-run
   * fields (id, status, startedAt, durationMs,
   * errorMessage, summary) so the UI can render
   * history rows with the same look as the main
   * table.
   */
  async history(
    name: string,
    opts: { limit?: number; skip?: number; status?: CronStatus } = {},
  ): Promise<{
    items: Array<{
      id: string
      name: string
      status: CronStatus
      startedAt: Date
      durationMs: number | null
      errorMessage: string | null
      summary: string | null
    }>
    total: number
    stats: {
      successCount: number
      failedCount: number
      skippedCount: number
      avgDurationMs: number | null
      p95DurationMs: number | null
    }
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const skip = Math.max(opts.skip ?? 0, 0)
    const where: any = { name }
    if (opts.status) where.status = opts.status

    // Parallel: items + total + stats. The stats
    // query is over the last 20 runs (so it
    // reflects recent performance, not all-time).
    const [items, total, recent] = await Promise.all([
      this.prisma.cronHealth.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        skip,
      }),
      this.prisma.cronHealth.count({ where }),
      // Stats: aggregate over the last 20 runs
      // (independent of the status filter — we
      // want the all-statuses trend, not just
      // failed).
      this.prisma.cronHealth.findMany({
        where: { name },
        orderBy: { startedAt: "desc" },
        take: 20,
        select: { status: true, durationMs: true },
      }),
    ])

    // Compute stats
    let successCount = 0
    let failedCount = 0
    let skippedCount = 0
    const durations: number[] = []
    for (const r of recent) {
      if (r.status === "success") successCount++
      else if (r.status === "failed") failedCount++
      else if (r.status === "skipped") skippedCount++
      if (r.durationMs != null) durations.push(r.durationMs)
    }
    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null
    // p95: sort ascending, take the 95th-percentile
    // value. With <20 samples, p95 = the largest.
    let p95DurationMs: number | null = null
    if (durations.length > 0) {
      const sorted = [...durations].sort((a, b) => a - b)
      const idx = Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * 0.95),
      )
      p95DurationMs = sorted[idx]
    }

    return {
      items: items.map((r) => ({
        id: r.id,
        name: r.name,
        // Cast: Prisma returns status as plain
        // `string` (the column is `String` in
        // schema.prisma). The value is one of the
        // 3 CronStatus values by convention; we
        // cast here rather than migrating the
        // schema. Tier 119+ uses this same
        // pattern.
        status: r.status as CronStatus,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        errorMessage: r.errorMessage,
        summary: r.summary,
      })),
      total,
      stats: {
        successCount,
        failedCount,
        skippedCount,
        avgDurationMs,
        p95DurationMs,
      },
    }
  }

  /**
   * Tier 195 — manually fire a registered cron job
   * outside its schedule. We use the SchedulerRegistry
   * to look up the cron by its registered name and
   * call `fireOnTick()`. The actual cron body still
   * runs the same way as a scheduled tick, including
   * the `record(...)` wrapper that updates the
   * CronHealth row. So the user sees a fresh
   * `lastRunAt` + `status` immediately after the
   * trigger.
   *
   * Why not just call the body method directly?
   * The scheduler body is private to its module —
   * invoking it here would require injecting every
   * scheduler service. SchedulerRegistry is the
   * canonical NestJS escape hatch and is the
   * documented way to fire a cron on demand.
   *
   * Tier 195 also has a safety guard: we refuse to
   * fire the `daily-auto-backup` cron via this
   * path. The backup is destructive (creates
   * ~50MB of dumps) and the operator should use
   * the dedicated POST /backup/run endpoint
   * which has its own confirm + audit log. The
   * fireOnTick path doesn't have a confirm step
   * so we block it explicitly.
   */
  async triggerManualRun(name: string): Promise<{
    name: string
    firedAt: string
    note: string
  }> {
    // Safety: refuse the destructive backup cron
    if (name === 'daily-auto-backup') {
      throw new BadRequestException(
        'daily-auto-backup cannot be triggered manually — use POST /api/v1/backup/run instead',
      )
    }
    // Validate the name against the registry of
    // expected crons. This catches typos (e.g.
    // 'webhook-retry' instead of 'webhook-retry-worker')
    // and rejects unknown names with 400 instead of
    // letting fireOnTick throw a generic scheduler
    // error.
    const known = CronHealthService.EXPECTED.map((c) => c.name)
    if (!known.includes(name)) {
      throw new BadRequestException(
        `unknown cron: ${name}. Known: ${known.join(', ')}`,
      )
    }
    let cronJob
    try {
      cronJob = this.schedulerRegistry.getCronJob(name)
    } catch (e) {
      // The scheduler registry raises NotFoundException
      // when the name isn't registered with @Cron.
      // Convert to BadRequest so the API surface is
      // consistent.
      throw new BadRequestException(
        `cron job not registered with @Cron: ${name}`,
      )
    }
    // fireOnTick is fire-and-forget on the scheduler's
    // own promise. The cron body runs asynchronously
    // and the operator polls the GET endpoint to see
    // the new lastRunAt land. We don't await the
    // body — that would tie up the HTTP request to
    // the cron's duration (which can be minutes for
    // the recurring-invoices run).
    void cronJob.fireOnTick()
    this.logger.log(`manually fired cron ${name}`)
    return {
      name,
      firedAt: new Date().toISOString(),
      note: 'fire-and-forget — poll GET /api/v1/admin/cron-health to see the new lastRunAt',
    }
  }
}
