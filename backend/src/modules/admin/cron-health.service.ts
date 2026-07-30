/**
 * CronHealthService — Tier 119 system health monitoring.
 *
 * Each of the 7 background crons (webhook-retry,
 * fints-sync, reminder-auto-send, vat-reverify,
 * exchange-rate-refresh, afa-auto-booker,
 * recurring-invoices) calls `record()` after every
 * run. The admin UI reads `list()` to show the
 * latest status of every cron.
 *
 * Why a service (not just SQL)?
 *   - Single source of truth for the schema
 *     (truncate error messages, normalise status
 *     to a small enum, default the startedAt to now).
 *   - The wrappers in the 7 schedulers stay
 *     one-liners: `try { ... } catch (e) { record(name,
 *     'failed', e); throw }` — the alternative (raw
 *     Prisma writes in each scheduler) would have
 *     duplicated the same try/finally logic 7 times.
 *   - `list()` joins the latest row per cron in a
 *     single query (raw SQL via $queryRaw is faster
 *     than 7 Prisma findFirst calls when the table
 *     grows).
 *
 * The `expected` map is a hand-curated registry of
 * every cron name + its schedule. We expose this
 * to the UI so the admin sees "next run in 3h 12m"
 * even if a cron has never fired (e.g. fresh DB).
 */
import { Injectable, Logger } from '@nestjs/common'
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

  constructor(private prisma: PrismaService) {}

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
}
