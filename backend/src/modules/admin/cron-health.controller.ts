/**
 * CronHealthController — REST surface for the admin
 * health dashboard. Two endpoints:
 *
 *   GET /api/v1/admin/cron-health
 *     → all known crons + their last run + next run +
 *       status. The UI renders this as a small table
 *       with green/red/amber dots.
 *
 *   POST /api/v1/admin/cron-health/clean
 *     → drop rows older than the retention window.
 *       Called by the cron-health.scheduler at 03:00
 *       every day (off-peak so a long DELETE doesn't
 *       block the user's other crons).
 *
 * Both endpoints require `admin.read` (or a custom
 * `system.read` role). For Tier 119 we reuse the
 * `admin` permission since the table is global and
 * the only consumer is the Berater/Mandant overview
 * page; we don't expose a per-user health endpoint.
 */
import { Controller, Get, Post } from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { CronHealthService } from './cron-health.service'

@Auth()
@Controller('admin/cron-health')
export class CronHealthController {
  constructor(private readonly health: CronHealthService) {}

  @Get()
  @Require('admin.read')
  async list() {
    return this.health.list()
  }

  @Post('clean')
  @Require('admin.read')
  async clean() {
    const deleted = await this.health.cleanOld(7)
    return { deleted }
  }
}
