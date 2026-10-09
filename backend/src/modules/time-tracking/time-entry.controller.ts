import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { TimeEntryInput, TimeEntryService } from './time-entry.service'

/**
 * Tier 611 — time tracking.
 *
 * GET    /time-entries?customerId&from&to&state=open|billed|all  → { data, summary }
 * POST   /time-entries                 { date, minutes, description, customerId?, hourlyRate?, billable? }
 * PUT    /time-entries/:id             the same fields, any of them
 * DELETE /time-entries/:id
 * POST   /time-entries/bill            { customerId, entryIds? }  → { invoiceId, invoiceNumber, entries, skipped, net, total }
 */
@Auth()
@Controller('time-entries')
export class TimeEntryController {
  constructor(private readonly service: TimeEntryService) {}

  private company(companyId: string): string {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return companyId
  }

  @Get()
  @Require('invoice.read')
  list(
    @Query('companyId') companyId: string,
    @Query('customerId') customerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('state') state?: string,
  ) {
    return this.service.list(this.company(companyId), { customerId, from, to, state })
  }

  // declared before :id — "bill" is no entry id
  @Post('bill')
  @Require('invoice.write')
  bill(@Query('companyId') companyId: string, @Body() body: { customerId?: unknown; entryIds?: unknown }) {
    return this.service.bill(this.company(companyId), body)
  }

  @Post()
  @Require('invoice.write')
  create(@Query('companyId') companyId: string, @Body() body: TimeEntryInput, @Req() req: any) {
    return this.service.create(this.company(companyId), req?.user?.id ?? null, body)
  }

  @Put(':id')
  @Require('invoice.write')
  update(@Param('id') id: string, @Query('companyId') companyId: string, @Body() body: TimeEntryInput) {
    return this.service.update(id, this.company(companyId), body)
  }

  @Delete(':id')
  @Require('invoice.write')
  remove(@Param('id') id: string, @Query('companyId') companyId: string) {
    return this.service.remove(id, this.company(companyId))
  }
}
