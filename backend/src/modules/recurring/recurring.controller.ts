import { Controller, Get, Post, Put, Delete, Body, Param, Query, BadRequestException } from '@nestjs/common';
import { RecurringService, RecurringInput } from './recurring.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('recurring-invoices')
export class RecurringController {
  constructor(private readonly svc: RecurringService) {}

  @Get()
  @Require('invoice.read')
  async list(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.list(companyId);
  }

  @Get(':id')
  @Require('invoice.read')
  async getOne(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.getOne(companyId, id);
  }

  @Post()
  @Require('invoice.create')
  async create(
    @Query('companyId') companyId: string,
    @Body() body: { createdById?: string } & RecurringInput,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const { createdById, ...input } = body;
    return this.svc.create(companyId, createdById, this.normalizeDates(input));
  }

  @Put(':id')
  @Require('invoice.update')
  async update(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: Partial<RecurringInput> & { isActive?: boolean },
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.update(companyId, id, this.normalizeDates(body));
  }

  /**
   * Convert short ISO date strings ("2026-06-01") into
   * full DateTime objects. Prisma's DateTime columns
   * reject bare dates; the frontend sends "YYYY-MM-DD"
   * for day-of-month fields like startDate, so we patch
   * them to midnight UTC here.
   */
  private normalizeDates<T extends Partial<RecurringInput>>(input: T): T {
    const out: any = { ...input }
    if (typeof out.startDate === 'string') {
      out.startDate = new Date(out.startDate + 'T00:00:00.000Z')
    }
    if (typeof out.endDate === 'string') {
      out.endDate = new Date(out.endDate + 'T00:00:00.000Z')
    }
    return out
  }

  @Delete(':id')
  @Require('invoice.delete')
  async remove(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.delete(companyId, id);
  }

  /**
   * Manually trigger ONE period of the template. Equivalent
   * to the cron tick firing for this template now. Used by
   * the "Jetzt generieren" button on the UI.
   */
  @Post(':id/run')
  @Require('invoice.create')
  async runOne(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.runOne(companyId, id, { trigger: 'manual' });
  }

  /**
   * Preview the next invoice this template would generate,
   * without persisting. Returns the line items + totals
   * the user would see if they hit "Jetzt generieren" now.
   */
  @Get(':id/preview')
  @Require('invoice.read')
  async preview(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.previewNext(companyId, id);
  }
}
