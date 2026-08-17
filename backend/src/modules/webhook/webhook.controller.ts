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
  HttpCode,
  Req,
} from '@nestjs/common'
import { Request } from 'express'
import { HeaderAuthGuard } from '../../auth/header-auth.guard'
import { RolesGuard } from '../../auth/roles.guard'
import { Require } from '../../auth/roles.decorator'
import { CurrentUser } from '../../auth/roles.decorator'
import { WebhookService, WebhookEvent } from './webhook.service'
import { PrismaService } from '../../prisma/prisma.service'
import { AuditService } from '../audit/audit.service'

@Controller('webhooks')
@UseGuards(HeaderAuthGuard, RolesGuard)
export class WebhookController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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
  //
  // Tier 201 — added optional
  // `eventType` query param so the
  // operator can scope the drawer to
  // a single event type
  // (e.g. only `payment.received`
  // failures, not `invoice.created`
  // ones). When omitted, all event
  // types are returned. Comma-
  // separated values are NOT
  // supported — use a single value
  // (or open the drawer twice).
  @Get(':id/deliveries')
  @Require('company.update')
  async listDeliveries(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('limit') limitStr?: string,
    @Query('eventType') eventType?: string,
  ) {
    const limit = Math.min(parseInt(limitStr || '50', 10) || 50, 200)
    const where: any = { webhookId: id, companyId }
    if (eventType) where.eventType = eventType
    return this.prisma.webhookDelivery.findMany({
      where,
      orderBy: { attemptedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        webhookId: true,
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

  /**
   * Manually replay a past delivery.
   *
   * URL: POST /webhooks/deliveries/:id/replay
   *
   * Operator scenario: the receiver
   * was down for hours, missed 47
   * events, the retry budget is
   * exhausted, and now the receiver
   * is back up. The operator opens
   * the deliveries drawer, sees a
   * failed or exhausted row, and
   * clicks "Replay". This endpoint
   * creates a fresh delivery with
   * the same eventId (so receivers
   * can dedupe), POSTs it to the
   * webhook URL, and returns the
   * new delivery row.
   *
   * The original delivery row stays
   * as-is — it preserves the audit
   * trail of what actually happened
   * at the time. The replay is a
   * separate row that operators
   * can scroll through to see what
   * was manually re-fired.
   *
   * RBAC: requires company.update
   * permission (admin only — same
   * as create/delete webhook).
   */
  @Post('deliveries/:id/replay')
  @Require('company.update')
  @HttpCode(200) // Replay isn't a "create" — it's an operator action on an existing row
  async replay(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    const replay = await this.webhooks.replayDelivery(id, companyId)
    return {
      ok: true,
      delivery: {
        id: replay.id,
        eventType: replay.eventType,
        eventId: replay.eventId,
        status: replay.status,
      },
    }
  }

  /**
   * Tier 198 — list all dead-letter
   * (exhausted) deliveries for the
   * company. Used by the dashboard's
   * "Dead-Letter Queue" section to
   * surface failed-and-gave-up rows
   * the operator can requeue.
   *
   * URL: GET /webhooks/deliveries/dead-letter
   *
   * Query:
   *   - companyId (required)
   *   - limit (optional, default 100, max 200)
   *
   * Returns an array of WebhookDelivery
   * rows with status='exhausted' + the
   * webhook name/url joined in (so the
   * UI can show "this delivery failed
   * on the 'Acme CRM' integration"
   * without a second round-trip).
   */
  @Get('deliveries/dead-letter')
  @Require('company.update')
  async listDeadLetter(
    @Query('companyId') companyId: string,
    @Query('limit') limitStr?: string,
    @Query('eventType') eventType?: string,
  ) {
    const limit = Math.min(parseInt(limitStr || '100', 10) || 100, 200)
    return this.webhooks.listDeadLetter(companyId, limit, eventType)
  }

  /**
   * Tier 198 — manually re-queue an
   * exhausted delivery.
   *
   * URL: POST /webhooks/deliveries/:id/requeue
   *
   * Operator scenario: the receiver
   * was down for hours, the retry
   * budget is exhausted on 47 events,
   * and the operator now knows the
   * receiver is back up. Instead of
   * clicking 47 "Replay" buttons
   * (which would create 47 new
   * delivery rows), they open the
   * Dead-Letter Queue and click
   * "Requeue" once per row. Each
   * click resets the existing row
   * back to status='failed' with
   * nextRetryAt=now(), so the cron
   * worker picks it up on the next
   * tick and retries through the
   * standard 1min/5min/30min
   * backoff schedule.
   *
   * RBAC: same as replay (admin only,
   * `company.update`).
   *
   * 400 if the row is not in
   * status='exhausted' (replay
   * already covers the
   * failed/pending edge case), or if
   * the underlying webhook is paused
   * or deleted.
   */
  @Post('deliveries/:id/requeue')
  @Require('company.update')
  @HttpCode(200)
  async requeue(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Req() req: Request,
  ) {
    const row = await this.webhooks.requeueDelivery(id, companyId)
    // Tier 202 — log the operator
    // action. entityId is the
    // delivery id so the Berater
    // can scope to "all requeue
    // events for delivery X".
    await this.audit.writeActivity({
      companyId,
      userId: (req as any).user?.id || null,
      action: 'webhook.requeue',
      entityType: 'WebhookDelivery',
      entityId: id,
      metadata: {
        webhookId: row.webhookId,
        eventType: row.eventType,
        eventId: row.eventId,
      },
    })
    return {
      ok: true,
      delivery: {
        id: row.id,
        eventType: row.eventType,
        eventId: row.eventId,
        status: row.status,
        retryCount: row.retryCount,
        nextRetryAt: row.nextRetryAt,
      },
    }
  }
}
