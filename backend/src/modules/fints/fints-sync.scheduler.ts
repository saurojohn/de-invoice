import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { FinTsService } from './fints.service'
import { PrismaService } from '../../prisma/prisma.service'

/**
 * Tier 6.5: Auto-sync scheduler.
 *
 * Runs the FinTS sync for every active
 * connection on a 4-hour interval. The
 * pattern mirrors `auto-reminder.scheduler`
 * (Tier 2) — a separate scheduler file
 * instead of cramming `@Cron` into the
 * service class, so the schedule surface
 * area is grep-able in one place.
 *
 * Cron: '0 star-slash-4 star star star' (Berlin) → 00:00,
 * 04:00, 08:00, 12:00, 16:00, 20:00.
 * Why 4h and not 1h: most banks rate-limit
 * FinTS requests to ~10/connection/24h
 * under PSD2. 4h = 6 requests/day, leaves
 * headroom for manual user-initiated syncs.
 * If a real bank returns 429 we back off
 * via the connection's own status field
 * (`error` → skipped on the next cron).
 *
 * Each cron tick:
 *
 * 1. Walks `FinTSConnection.status='active'`
 * 2. Calls `startSync()` per connection
 * 3. Records the outcome in
 *    `FinTSSyncRun` (the same table the
 *    manual sync uses — the audit log
 *    doesn't care who or what triggered
 *    the sync)
 * 4. Swallows per-connection errors so one
 *    bank's outage doesn't take the cron
 *    down
 *
 * Manual override: `POST /api/v1/fints/auto-run`
 * calls `runAutoSync()` synchronously,
 * bypassing the cron (so an admin can
 * test the flow after disabling the
 * schedule). The endpoint is mounted in
 * the FinTsController.
 */
@Injectable()
export class FintsSyncScheduler {
  private readonly logger = new Logger(FintsSyncScheduler.name)
  // Track the last auto-run for the admin
  // endpoint. null on cold start.
  private lastAutoRun: {
    startedAt: Date
    finishedAt: Date
    connections: number
    ok: number
    needsTan: number
    failed: number
  } | null = null

  constructor(
    private fints: FinTsService,
    private prisma: PrismaService,
  ) {}

  @Cron('0 */4 * * *', { timeZone: 'Europe/Berlin' })
  async runScheduled() {
    this.logger.log('Cron fints-auto-sync: starting')
    const result = await this.runAutoSync()
    this.logger.log(
      `Cron fints-auto-sync: done (${result.ok} ok, ${result.needsTan} needs_tan, ${result.failed} failed of ${result.connections} connections)`,
    )
  }

  /**
   * The shared core for the cron and the
   * manual endpoint. Records the outcome
   * in `lastAutoRun` so the admin UI can
   * show "Last auto-run: 12 min ago, 3 ok,
   * 1 needs_tan, 0 failed".
   */
  async runAutoSync() {
    const startedAt = new Date()
    const result = await this.fints.autoSyncAllActive()
    const finishedAt = new Date()
    this.lastAutoRun = { startedAt, finishedAt, ...result }
    return this.lastAutoRun
  }

  getLastAutoRun() {
    return this.lastAutoRun
  }
}
