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

  @Get('stats')
  @Require('invoice.read')
  async stats(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.stats(companyId);
  }

  /**
   * Tier 63: prefill payload for "convert this invoice
   * into a recurring template". Returns the shape the
   * recurring-invoices page create-modal consumes.
   * Declared BEFORE `:id` per the NestJS route-order
   * gotcha — first match wins, so `:id` would
   * otherwise swallow "stats" / "from-invoice".
   */
  @Get('from-invoice/:invoiceId')
  @Require('invoice.read')
  async fromInvoice(
    @Query('companyId') companyId: string,
    @Param('invoiceId') invoiceId: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.fromInvoice(companyId, invoiceId);
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
    // Tier 129: runOneAndEmail wraps runOne + the
    // post-generation email send (no-op if
    // template.sendEmail=false). Fire-and-forget on
    // the email — the controller returns the invoice
    // ID immediately, the email completes in the
    // background and is logged.
    return this.svc.runOneAndEmail(companyId, id, { trigger: 'manual' });
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

  /**
   * Tier 136: preview the email that would be sent
   * if this template ran right now. Returns the
   * rendered subject + body (with sample invoice
   * number + amounts), the recipient address, and
   * a flag if no recipient is on file. The operator
   * can sanity-check the email BEFORE flipping
   * sendEmail=true.
   */
  @Get(':id/preview-email')
  @Require('invoice.read')
  async previewEmail(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.svc.previewEmail(companyId, id);
  }

  /**
   * Tier 147: list every invoice this template
   * has ever generated.
   *
   * The admin's primary question for a long-
   * running template: "what did the Hosting
   * Wartungsvertrag generate in 2025?" — without
   * this endpoint they'd have to walk the full
   * audit log + filter by action=invoice.created
   * + grep for the template id. Now it's one
   * GET away.
   *
   * Filters: date range, status, customerId.
   * Sorted by issueDate DESC (newest first).
   * Paginated, max 200.
   */
  @Get(':id/generated-invoices')
  @Require('invoice.read')
  async generatedInvoices(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('skip') skipStr?: string,
    @Query('take') takeStr?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const opts: any = { templateId: id }
    if (fromStr) {
      const d = new Date(fromStr)
      if (isNaN(d.getTime()))
        throw new BadRequestException('Invalid from (ISO 8601)')
      opts.from = d
    }
    if (toStr) {
      const d = new Date(toStr)
      if (isNaN(d.getTime()))
        throw new BadRequestException('Invalid to (ISO 8601)')
      opts.to = d
    }
    if (status) opts.status = status
    if (customerId) opts.customerId = customerId
    if (skipStr) {
      const n = parseInt(skipStr, 10)
      if (isNaN(n) || n < 0) throw new BadRequestException('Invalid skip')
      opts.skip = n
    }
    if (takeStr) {
      const n = parseInt(takeStr, 10)
      if (isNaN(n) || n < 1 || n > 200)
        throw new BadRequestException('Invalid take (1-200)')
      opts.take = n
    }
    return this.svc.generatedInvoices(companyId, opts)
  }
}
