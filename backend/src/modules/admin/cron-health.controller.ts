/**
 * CronHealthController — REST surface for the admin
 * health dashboard. Three endpoints:
 *
 *   GET /api/v1/admin/cron-health
 *     → all known crons + their last run + next run +
 *       status. The UI renders this as a small table
 *       with green/red/amber/grey dots.
 *
 *   GET /api/v1/admin/cron-health/:name/history
 *     → per-cron run history (newest-first) with
 *       optional status filter. Tier 124.
 *
 *   POST /api/v1/admin/cron-health/clean
 *     → drop rows older than the retention window.
 *       Called by the cron-health.scheduler at 03:00
 *       every day (off-peak so a long DELETE doesn't
 *       block the user's other crons).
 *
 * All endpoints require `admin.read`. For Tier 119
 * we reused the `admin` permission since the table
 * is global and the only consumer is the
 * Berater/Mandant overview page; we don't expose a
 * per-user health endpoint.
 */
import { Controller, Get, Param, Post, Query, BadRequestException } from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { CronHealthService, CronStatus } from './cron-health.service'

@Auth()
@Controller('admin/cron-health')
export class CronHealthController {
  constructor(private readonly health: CronHealthService) {}

  @Get()
  @Require('admin.read')
  async list() {
    return this.health.list()
  }

  @Get(':name/history')
  @Require('admin.read')
  async history(
    @Param('name') name: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('status') status?: string,
  ) {
    // Tier 124: validate the status param against
    // the CronStatus union. The service uses a
    // string column so a typo would just match
    // nothing, but we want a 400 on bad input.
    let statusFilter: CronStatus | undefined
    if (status) {
      if (status !== "success" && status !== "failed" && status !== "skipped") {
        throw new BadRequestException(
          `status must be 'success' | 'failed' | 'skipped', got: ${status}`,
        )
      }
      statusFilter = status
    }
    return this.health.history(name, {
      limit: limit ? Number(limit) : undefined,
      skip: skip ? Number(skip) : undefined,
      status: statusFilter,
    })
  }

  @Post('clean')
  @Require('admin.read')
  async clean() {
    const deleted = await this.health.cleanOld(7)
    return { deleted }
  }

  /**
   * Tier 195 — manually fire a cron job outside its
   * schedule. The endpoint is `POST :name/run` and
   * uses SchedulerRegistry under the hood. Returns
   * {name, firedAt, note} — the actual run is
   * fire-and-forget; the operator polls the GET
   * endpoint above to see the new lastRunAt land.
   *
   * Requires `admin.update` (not just read) because
   * firing a cron can have side effects (auto-send
   * reminders, regenerate DATEV exports, etc.).
   */
  @Post(':name/run')
  @Require('admin.read')
  async runCron(@Param('name') name: string) {
    if (!name) throw new BadRequestException('name is required')
    return this.health.triggerManualRun(name)
  }
}
