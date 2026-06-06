import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
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
