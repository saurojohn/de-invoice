import { Controller, Get, Post, Put, Body, Param, Query, BadRequestException } from '@nestjs/common';
import { ReminderService } from './reminder.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('reminders')
export class ReminderController {
  constructor(private readonly reminderService: ReminderService) {}

  @Get('overdue')
  @Require('invoice.read')
  async getOverdueInvoices(@Query('companyId') companyId: string) {
    return this.reminderService.findOverdueInvoices(companyId);
  }

  @Get('stats')
  @Require('invoice.read')
  async getReminderStats(@Query('companyId') companyId: string) {
    return this.reminderService.getReminderStats(companyId);
  }

  /**
   * List all three reminder templates (first / second / final)
   * for the company. Each one is auto-seeded with the default
   * German wording the first time it's requested, so the UI
   * always sees three rows.
   */
  @Get('templates')
  @Require('invoice.read')
  async listTemplates(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const levels: Array<'first' | 'second' | 'final'> = ['first', 'second', 'final'];
    return Promise.all(levels.map((level) => this.reminderService.getOrCreateTemplate(companyId, level)));
  }

  /**
   * Get a single level's template. Auto-seeds the default
   * if none exists yet (so the form is never empty on first
   * open).
   */
  @Get('templates/:level')
  @Require('invoice.read')
  async getTemplate(
    @Query('companyId') companyId: string,
    @Param('level') level: 'first' | 'second' | 'final',
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!['first', 'second', 'final'].includes(level)) {
      throw new BadRequestException('level must be first, second or final');
    }
    return this.reminderService.getOrCreateTemplate(companyId, level);
  }

  /**
   * Update a reminder template. The user edits subject / body
   * in the UI and we save here. Flips `isDefault` to false
   * so the UI can show a "Customized" badge.
   *
   * Render preview: the body is run through renderForInvoice
   * with the most recent overdue invoice (if any) so the
   * user can see the placeholders resolved before sending.
   */
  @Put('templates/:level')
  @Require('invoice.update')
  async updateTemplate(
    @Query('companyId') companyId: string,
    @Param('level') level: 'first' | 'second' | 'final',
    @Body() body: { subject: string; body: string },
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!['first', 'second', 'final'].includes(level)) {
      throw new BadRequestException('level must be first, second or final');
    }
    if (!body.subject?.trim() || !body.body?.trim()) {
      throw new BadRequestException('subject and body are required');
    }
    // Make sure the row exists (auto-seed if not).
    await this.reminderService.getOrCreateTemplate(companyId, level);
    return this.reminderService.updateTemplateRow(companyId, level, {
      subject: body.subject.trim(),
      body: body.body.trim(),
      isDefault: false,
    });
  }

  /**
   * Reset a template back to the bundled default. Useful
   * when the user has edited it and wants to start over.
   */
  @Post('templates/:level/reset')
  @Require('invoice.update')
  async resetTemplate(
    @Query('companyId') companyId: string,
    @Param('level') level: 'first' | 'second' | 'final',
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!['first', 'second', 'final'].includes(level)) {
      throw new BadRequestException('level must be first, second or final');
    }
    // Wipe any user-customised version, then re-seed.
    await this.reminderService.deleteTemplate(companyId, level);
    return this.reminderService.getOrCreateTemplate(companyId, level);
  }

  /**
   * Preview a template with the most recent overdue invoice
   * (or any invoice id provided). Returns the rendered
   * subject + body so the user can see the placeholders
   * resolved.
   */
  @Get('templates/:level/preview')
  @Require('invoice.read')
  async previewTemplate(
    @Query('companyId') companyId: string,
    @Param('level') level: 'first' | 'second' | 'final',
    @Query('invoiceId') invoiceId?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!['first', 'second', 'final'].includes(level)) {
      throw new BadRequestException('level must be first, second or final');
    }
    // If no invoiceId, fall back to the most recent invoice
    // for the company (any status) so the user can still
    // see what the rendered template looks like.
    let id: string = invoiceId || '';
    if (!id) {
      const latest = await this.reminderService.latestInvoiceId(companyId);
      if (!latest) {
        throw new BadRequestException('No invoice available for preview');
      }
      id = latest;
    }
    return this.reminderService.renderForInvoice(id, companyId, level);
  }

  @Get(':invoiceId/email-data')
  @Require('invoice.send')
  async getReminderEmailData(
    @Param('invoiceId') invoiceId: string,
    @Query('companyId') companyId: string,
    @Query('level') level: 'first' | 'second' | 'final',
  ) {
    return this.reminderService.getReminderEmailData(invoiceId, companyId, level);
  }

  @Post('send')
  @Require('invoice.send')
  async sendReminder(
    @Body()
    body: {
      invoiceId: string;
      companyId: string;
      recipientEmail: string;
      recipientName: string;
      subject: string;
      body: string;
      level: 'first' | 'second' | 'final';
      createdById?: string;
    },
  ) {
    const reminder = await this.reminderService.recordReminderSend(
      body.companyId,
      body.invoiceId,
      body.recipientEmail,
      body.recipientName,
      body.subject,
      body.body,
      body.level,
      body.createdById,
    );

    return {
      success: true,
      reminderId: reminder.id,
      message: 'Erinnerung wurde erfolgreich gesendet',
    };
  }
}
