import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common'
import { HeaderAuthGuard } from '../../auth/header-auth.guard'
import { RolesGuard } from '../../auth/roles.guard'
import { Require } from '../../auth/roles.decorator'
import { CurrentUser } from '../../auth/roles.decorator'
import { WebhookService, WebhookEvent } from './webhook.service'
import { PrismaService } from '../../prisma/prisma.service'

@Controller('webhooks')
@UseGuards(HeaderAuthGuard, RolesGuard)
export class WebhookController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly prisma: PrismaService,
  ) {}

  // List all webhooks for the company.
  // Returns id, name, url, events,
  // status — NEVER the secret (the
  // caller has the secret from create
  // time and can rotate by delete+create).
  @Get()
  @Require('company.update') // admin only
  async list(@Query('companyId') companyId: string) {
    return this.webhooks.list(companyId)
  }

  // Create a new webhook. Returns
  // the secret ONCE in the response —
  // the caller must save it.
  @Post()
  @Require('company.update')
  async create(
    @Query('companyId') companyId: string,
    @Body() body: {
      name: string
      url: string
      events: string[]
      description?: string
    },
    @CurrentUser() user: any,
  ) {
    if (!body.name || !body.url || !Array.isArray(body.events)) {
      throw new BadRequestException('name, url, and events[] are required')
    }
    return this.webhooks.create({
      companyId,
      createdById: user?.id,
      name: body.name,
      url: body.url,
      events: body.events,
      description: body.description,
    })
  }

  // Update a webhook. The URL and
  // secret are immutable (rotation
  // requires delete + create).
  @Patch(':id')
  @Require('company.update')
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: {
      name?: string
      events?: string[]
      status?: 'active' | 'paused' | 'disabled'
      description?: string
    },
  ) {
    return this.webhooks.update(id, companyId, body)
  }

  // Soft-delete (sets status='disabled').
  // We keep the row for delivery
  // history.
  @Delete(':id')
  @Require('company.update')
  async delete(@Param('id') id: string, @Query('companyId') companyId: string) {
    await this.webhooks.delete(id, companyId)
    return { ok: true }
  }

  // List recent deliveries for a
  // webhook — for debugging "why
  // didn't my integration receive
  // invoice.created yesterday?".
  @Get(':id/deliveries')
  @Require('company.update')
  async listDeliveries(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('limit') limitStr?: string,
  ) {
    const limit = Math.min(parseInt(limitStr || '50', 10) || 50, 200)
    return this.prisma.webhookDelivery.findMany({
      where: { webhookId: id, companyId },
      orderBy: { attemptedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        eventType: true,
        eventId: true,
        status: true,
        statusCode: true,
        durationMs: true,
        retryCount: true,
        errorMessage: true,
        attemptedAt: true,
        nextRetryAt: true,
      },
    })
  }

  // Test endpoint: send a synthetic
  // event to a webhook. Useful for
  // debugging "is my integration
  // set up correctly?" without
  // having to create a real
  // invoice. Only admins.
  @Post(':id/test')
  @Require('company.update')
  async test(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    const wh = await this.prisma.webhook.findFirst({
      where: { id, companyId },
    })
    if (!wh) throw new NotFoundException('Webhook not found')
    const result = await this.webhooks.emit({
      id: `test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      type: 'webhook.test',
      occurredAt: new Date().toISOString(),
      companyId,
      data: {
        message: 'This is a test event from de-invoice',
        webhookName: wh.name,
      },
    })
    return {
      ok: true,
      delivered: result.delivered,
      // Note: we don't await the
      // delivery — the test endpoint
      // returns immediately. Check
      // the deliveries list to see
      // the result.
    }
  }
}
