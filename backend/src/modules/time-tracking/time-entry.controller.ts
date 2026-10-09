import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import { Auth, Require } from '../../auth/roles.decorator'
import { TimeEntryInput, TimeEntryService } from './time-entry.service'
import { generateTimesheetPdf } from './timesheet-pdf'

/**
 * Tier 611 — time tracking.
 *
 * GET    /time-entries?customerId&from&to&state=open|billed|all  → { data, summary }
 * POST   /time-entries                 { date, minutes, description, customerId?, hourlyRate?, billable? }
 * PUT    /time-entries/:id             the same fields, any of them
 * DELETE /time-entries/:id
 * POST   /time-entries/bill            { customerId, entryIds?, projectId? }  → { invoiceId, invoiceNumber, entries, skipped, net, total }
 *
 * Tier 616: `projectId` on an entry and as a filter. Tier 617: the timer —
 * GET    /time-entries/timer           → { running: null | { startedAt, elapsedSeconds, customerId, projectId, description } }
 * POST   /time-entries/timer/start     { customerId?, projectId?, description? }
 * POST   /time-entries/timer/stop      { description?, customerId?, projectId?, hourlyRate?, billable? } → { entry, capped }
 * DELETE /time-entries/timer           discards it
 * Tier 618:
 * GET    /time-entries/timesheet.pdf?customerId&projectId&invoiceId&from&to&state → the Stundennachweis
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
    @Query('projectId') projectId?: string,
    @Query('invoiceId') invoiceId?: string,
  ) {
    return this.service.list(this.company(companyId), { customerId, projectId, invoiceId, from, to, state })
  }

  // ── declared before :id — "timer", "timesheet.pdf" and "bill" are no entry ids ──

  @Get('timesheet.pdf')
  @Require('invoice.read')
  async timesheet(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('customerId') customerId?: string,
    @Query('projectId') projectId?: string,
    @Query('invoiceId') invoiceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('state') state?: string,
  ) {
    const sheet = await this.service.timesheet(this.company(companyId), { customerId, projectId, invoiceId, from, to, state })
    const pdf = await generateTimesheetPdf({
      companyName: sheet.company?.name ?? '',
      companyAddress: (sheet.company?.address ?? null) as { street?: string; postalCode?: string; city?: string } | null,
      customerName: sheet.customer?.name ?? null,
      customerNumber: sheet.customer?.customerNumber ?? null,
      projectName: sheet.project?.name ?? null,
      invoiceNumber: sheet.invoiceNumber,
      from: sheet.from,
      to: sheet.to,
      entries: sheet.entries,
    })
    const name = sheet.invoiceNumber ? `Stundennachweis_${sheet.invoiceNumber}` : 'Stundennachweis'
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${name}.pdf"`,
      'Content-Length': pdf.length,
      'X-Timesheet-Entries': String(sheet.entries.length),
      'X-Timesheet-Minutes': String(sheet.entries.reduce((s, e) => s + e.minutes, 0)),
    })
    res.end(pdf)
  }

  // Tier 625
  @Get('report')
  @Require('invoice.read')
  report(@Query('companyId') companyId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('groupBy') groupBy?: string) {
    return this.service.report(this.company(companyId), { from, to, groupBy })
  }

  // Tier 628
  @Get('report.csv')
  @Require('invoice.read')
  async reportCsv(@Res() res: Response, @Query('companyId') companyId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('groupBy') groupBy?: string) {
    const { csv, filename } = await this.service.reportCsv(this.company(companyId), { from, to, groupBy })
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` })
    res.send(csv)
  }

  // Tier 624: the rounding rule — everyone reads it, the company's admin sets it
  @Get('settings')
  @Require('invoice.read')
  async settings(@Query('companyId') companyId: string) {
    return { rounding: await this.service.rounding(this.company(companyId)) }
  }

  @Put('settings')
  @Require('company.update')
  async setSettings(@Query('companyId') companyId: string, @Body() body: { rounding?: { minutes?: unknown; mode?: unknown } }) {
    return { rounding: await this.service.setRounding(this.company(companyId), body?.rounding ?? {}) }
  }

  // Tier 623
  @Post('timer/pause')
  @Require('invoice.write')
  pauseTimer(@Query('companyId') companyId: string, @Req() req: any) {
    return this.service.pauseTimer(this.company(companyId), req?.user?.id ?? null)
  }

  @Post('timer/resume')
  @Require('invoice.write')
  resumeTimer(@Query('companyId') companyId: string, @Req() req: any) {
    return this.service.resumeTimer(this.company(companyId), req?.user?.id ?? null)
  }

  @Get('timer')
  @Require('invoice.read')
  timer(@Query('companyId') companyId: string, @Req() req: any) {
    return this.service.timer(this.company(companyId), req?.user?.id ?? null)
  }

  @Post('timer/start')
  @Require('invoice.write')
  startTimer(@Query('companyId') companyId: string, @Body() body: TimeEntryInput, @Req() req: any) {
    return this.service.startTimer(this.company(companyId), req?.user?.id ?? null, body)
  }

  @Post('timer/stop')
  @Require('invoice.write')
  stopTimer(@Query('companyId') companyId: string, @Body() body: TimeEntryInput, @Req() req: any) {
    return this.service.stopTimer(this.company(companyId), req?.user?.id ?? null, body)
  }

  @Delete('timer')
  @Require('invoice.write')
  discardTimer(@Query('companyId') companyId: string, @Req() req: any) {
    return this.service.discardTimer(this.company(companyId), req?.user?.id ?? null)
  }

  @Post('bill')
  @Require('invoice.write')
  bill(@Query('companyId') companyId: string, @Body() body: { customerId?: unknown; entryIds?: unknown; projectId?: unknown }) {
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
