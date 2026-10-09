import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { TimeProjectInput, TimeProjectService } from './time-project.service'

/**
 * Tier 616 — projects for the time tracking.
 *
 * GET    /time-projects?customerId&includeInactive=true  → { data: [… + effectiveRate, minutes, openMinutes] }
 * POST   /time-projects        { name, customerId?, hourlyRate?, budgetHours? }
 * PUT    /time-projects/:id    the same fields and `active`
 * DELETE /time-projects/:id    only without hours — else archive it
 */
@Auth()
@Controller('time-projects')
export class TimeProjectController {
  constructor(private readonly service: TimeProjectService) {}

  private company(companyId: string): string {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return companyId
  }

  @Get()
  @Require('invoice.read')
  list(@Query('companyId') companyId: string, @Query('customerId') customerId?: string, @Query('includeInactive') includeInactive?: string) {
    return this.service.list(this.company(companyId), { customerId, includeInactive: includeInactive === 'true' })
  }

  @Post()
  @Require('invoice.write')
  create(@Query('companyId') companyId: string, @Body() body: TimeProjectInput) {
    return this.service.create(this.company(companyId), body)
  }

  @Put(':id')
  @Require('invoice.write')
  update(@Param('id') id: string, @Query('companyId') companyId: string, @Body() body: TimeProjectInput) {
    return this.service.update(id, this.company(companyId), body)
  }

  @Delete(':id')
  @Require('invoice.write')
  remove(@Param('id') id: string, @Query('companyId') companyId: string) {
    return this.service.remove(id, this.company(companyId))
  }
}
