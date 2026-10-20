import { BadRequestException, Controller, NotFoundException, Post, Query } from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { OverdueStatusScheduler } from './overdue-status.scheduler'

/**
 * Tier 710 — test-only: the nightly overdue job for one company, so a spec
 * can see what 00:05 does (DISABLE_CRON keeps the job itself off in the
 * suites). Unreachable in production, like the recurring module's
 * `_test/scheduled-run`.
 */
@Auth()
@Controller('invoice-status')
export class OverdueStatusController {
  constructor(private readonly job: OverdueStatusScheduler) {}

  @Post('_test/mark-overdue')
  @Require('admin.update')
  async markOverdue(@Query('companyId') companyId: string) {
    if (process.env.NODE_ENV === 'production') throw new NotFoundException()
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.job.run(companyId)
  }
}
