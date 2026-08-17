// Tier 14: Webhook delivery service.
//
// Sends HTTP POST requests to webhook
// receivers when business events fire.
// The flow:
//
//   1. Caller invokes `webhooks.emit(event, data)`.
//   2. The service queries all active
//      webhooks for the company that
//      subscribe to the event type.
//   3. For each subscriber, the service
//      creates a WebhookDelivery row
//      (status='pending'), then
//      asynchronously POSTs the payload
//      with an HMAC-SHA256 signature in
//      the X-Signature header.
//   4. The receiver's response (status
//      code + body) is recorded on the
//      WebhookDelivery row. status is
//      updated to 'success' or 'failed'.
//
// Retries:
//   - 2xx response → success, no retry
//   - 4xx response → permanent failure
//     (the request is malformed; the
//     receiver is telling us "don't
//     retry this")
//   - 5xx response OR network error →
//     failed, schedule a retry with
//     exponential backoff (1min, 5min,
//     30min). After 3 failed retries,
//     status='exhausted'. Operators
//     notice this via the deliveries
//     list (`GET /webhooks/:id/deliveries`)
//     or by querying the DB for
//     `WebhookDelivery.status='exhausted'`.
//
// Why async (not synchronous)?
//   We don't want an HTTP call to a
//   broken receiver to slow down the
//   invoice creation request. The
//   delivery is fire-and-forget. If the
//   backend crashes mid-delivery, the
//   delivery row is in 'pending' state
//   and a startup hook retries it.
//
// Idempotency:
//   Each event has a stable `eventId`
//   (e.g. "inv_8c6a9669-..." for
//   invoice.created). Receivers should
//   dedupe on eventId to handle the
//   case where the SAME event is
//   delivered multiple times (retry
//   after crash, etc.).
//
// Signature:
//   The X-Signature header is
//   `sha256=<hex>` where hex is the
//   HMAC-SHA256 of the raw body using
//   the webhook's secret as the key.
//   Receivers verify by recomputing
//   the HMAC and comparing in
//   constant time.

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { createHmac, randomBytes } from 'crypto'
import { URL } from 'url'

export type WebhookEventType =
  | 'invoice.created'
  | 'invoice.updated'
  | 'invoice.paid'
  | 'invoice.sent'
  | 'invoice.deleted'
  | 'payment.received'
  | 'voucher.created'
  | 'voucher.posted'
  | 'voucher.reversed'
  | 'customer.created'
  | 'customer.updated'
  | 'company.updated'
  // Add more events here as needed.
  | string

export interface WebhookEvent {
  // Stable id for idempotency. Receivers
  // should dedupe on this.
  id: string
  type: WebhookEventType
  // ISO timestamp of when the event
  // happened (server-side, not the
  // receiver's clock).
  occurredAt: string
  companyId: string
  // The event payload. Receivers should
  // NOT trust field shapes — we add
  // fields over time, and old receivers
  // should ignore unknown fields.
  data: Record<string, any>
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a new webhook secret.
   * 32 random bytes, base64url-encoded
   * (43 chars). Shown to the user ONCE
   * on create; never returned by GET.
   */
  static generateSecret(): string {
    return randomBytes(32).toString('base64url')
  }

  /**
   * Sign a payload with the given secret.
   * The output is the value of the
   * X-Signature header (without the
   * `sha256=` prefix).
   */
  static sign(secret: string, body: string): string {
    return createHmac('sha256', secret).update(body).digest('hex')
  }

  /**
   * List all webhooks for a company.
   * Secrets are NOT returned (caller
   * already has them from create time).
   */
  /**
   * Tier 199 — list webhooks for a
   * company, enriched with the most
   * recent successful delivery AND the
   * most recent delivery (any status)
   * per webhook. The UI uses these two
   * timestamps to render a "last
   * successful" badge in the webhooks
   * list (Tier 199).
   *
   * Implementation: 2 prisma.groupBy
   * queries (one for status='success',
   * one for any status) instead of N+1.
   * For a company with 10 webhooks,
   * that's 2 queries vs 20. The
   * groupBy is per companyId (not
   * global) so it can't leak across
   * tenants.
   *
   * Returns: array of webhooks, each
   * with two extra fields:
   *   - lastSuccessAt: Date | null
   *     (null = no successful delivery
   *     ever — webhook is new, or
   *     every attempt has failed)
   *   - lastDeliveryAt: Date | null
   *     (null = no delivery attempts
   *     ever — webhook was created but
   *     never fired an event)
   */
  async list(companyId: string) {
    const [webhooks, successByWebhook, lastByWebhook] = await Promise.all([
      this.prisma.webhook.findMany({
        where: { companyId, status: { not: 'disabled' } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          url: true,
          events: true,
          status: true,
          description: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      // Most recent SUCCESS per webhook.
      // Returns one row per webhookId
      // that has at least one success
      // delivery. Webhooks with no
      // success yet are absent from the
      // result (and get lastSuccessAt
      // = null below).
      this.prisma.webhookDelivery.groupBy({
        by: ['webhookId'],
        where: { companyId, status: 'success' },
        _max: { attemptedAt: true },
      }),
      // Most recent DELIVERY (any
      // status) per webhook. Same shape.
      this.prisma.webhookDelivery.groupBy({
        by: ['webhookId'],
        where: { companyId },
        _max: { attemptedAt: true },
      }),
    ])
    const successMap = new Map(
      successByWebhook.map((r) => [r.webhookId, r._max.attemptedAt]),
    )
    const lastMap = new Map(
      lastByWebhook.map((r) => [r.webhookId, r._max.attemptedAt]),
    )
    return webhooks.map((wh) => ({
      ...wh,
      lastSuccessAt: successMap.get(wh.id) ?? null,
      lastDeliveryAt: lastMap.get(wh.id) ?? null,
    }))
  }

  /**
   * Create a new webhook. The secret is
   * generated server-side and returned
   * ONCE in the response (the caller
   * must save it — we never return it
   * again from GET).
   */
  async create(input: {
    companyId: string
    createdById?: string
    name: string
    url: string
    events: string[]
    description?: string
  }) {
    if (!isValidUrl(input.url)) {
      throw new BadRequestException(
        'Invalid webhook URL: must be a public http(s) URL (private IPs and localhost are not allowed)',
      )
    }
    if (input.events.length === 0) {
      throw new BadRequestException('At least one event type is required')
    }
    const secret = WebhookService.generateSecret()
    return this.prisma.webhook.create({
      data: {
        companyId: input.companyId,
        createdById: input.createdById,
        name: input.name,
        url: input.url,
        events: JSON.stringify(input.events),
        description: input.description,
        secret,
      },
      select: {
        id: true,
        companyId: true,
        name: true,
        url: true,
        events: true,
        status: true,
        description: true,
        createdAt: true,
        // Secret is included ONLY on create.
        // GET endpoints (list/get) omit it.
        secret: true,
      },
    })
  }

  /**
   * Update a webhook (e.g. pause it, change
   * the event list). The URL and secret
   * are immutable (changing them would
   * break the receiver's signature
   * verification) — the user must delete
   * + recreate if they need to rotate.
   */
  async update(
    id: string,
    companyId: string,
    input: { name?: string; events?: string[]; status?: string; description?: string },
  ) {
    return this.prisma.webhook.update({
      where: { id, companyId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.events !== undefined ? { events: JSON.stringify(input.events) } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      select: {
        id: true,
        name: true,
        url: true,
        events: true,
        status: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  }

  async delete(id: string, companyId: string) {
    // Soft-delete: keep the row for
    // delivery history. The list()
    // endpoint filters out status='disabled'.
    return this.prisma.webhook.update({
      where: { id, companyId },
      data: { status: 'disabled' },
    })
  }

  /**
   * Emit an event. Looks up all active
   * subscribers and asynchronously POSTs
   * the payload to each. Returns
   * immediately — actual delivery is
   * fire-and-forget.
   */
  async emit(event: WebhookEvent): Promise<{ delivered: number }> {
    const subscribers = await this.prisma.webhook.findMany({
      where: {
        companyId: event.companyId,
        status: 'active',
      },
    })
    let delivered = 0
    for (const wh of subscribers) {
      const subscribedEvents: string[] = JSON.parse(wh.events || '[]')
      if (!subscribedEvents.includes(event.type) && !subscribedEvents.includes('*')) {
        continue
      }
      // Create the delivery row, then
      // fire the HTTP call without
      // awaiting (fire-and-forget so the
      // caller isn't blocked).
      const delivery = await this.prisma.webhookDelivery.create({
        data: {
          webhookId: wh.id,
          companyId: wh.companyId,
          eventType: event.type,
          eventId: event.id,
          payload: event as any,
          status: 'pending',
        },
      })
      // Fire-and-forget. We don't await
      // this — the .catch() handles
      // errors so they don't become
      // unhandled promise rejections.
      // Fire-and-forget. We don't await
      // this — the .catch() handles
      // errors so they don't become
      // unhandled promise rejections.
      this.deliver(delivery.id, wh.url, wh.secret, event).catch((err) => {
        this.logger.error(`webhook ${wh.id} delivery ${delivery.id} failed: ${err}`)
      })
      delivered += 1
    }
    return { delivered }
  }

  /**
   * Actually deliver a single webhook.
   * Called from emit() — NOT exposed via
   * the controller. Updates the
   * WebhookDelivery row with the result.
   */
  /**
   * Re-attempt a single failed delivery.
   * Called by the retry cron worker. Bumps
   * retryCount + re-runs the HTTP POST.
   *
   * Returns the new delivery status so the
   * cron worker can log it.
   */
  async retryDelivery(deliveryId: string): Promise<'success' | 'failed' | 'exhausted' | 'not-found'> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true },
    })
    if (!delivery) return 'not-found'
    if (delivery.status !== 'failed') {
      // Either already succeeded, never
      // existed, or exhausted. Don't retry.
      return 'not-found'
    }
    if (!delivery.webhook || delivery.webhook.status !== 'active') {
      // The webhook was paused or deleted
      // between failures. Don't retry.
      return 'not-found'
    }
    // Bump retry count BEFORE the attempt
    // so the durationMs / statusCode / etc.
    // update below records the new attempt.
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { retryCount: { increment: 1 } },
    })
    await this.deliver(
      deliveryId,
      delivery.webhook.url,
      delivery.webhook.secret,
      delivery.payload as unknown as WebhookEvent,
    )
    // Read back the status so the caller
    // can see if the retry succeeded.
    const updated = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      select: { status: true },
    })
    return (updated?.status as 'success' | 'failed' | 'exhausted') ?? 'failed'
  }

  /**
   * Find all deliveries due for retry.
   * Called by the cron worker every minute.
   * Returns at most `limit` rows to avoid
   * overwhelming Postgres with a huge
   * queue if the receiver has been down
   * for hours.
   */
  async findDueRetries(limit = 50): Promise<{ id: string; webhookId: string }[]> {
    return this.prisma.webhookDelivery.findMany({
      where: {
        status: 'failed',
        nextRetryAt: { lte: new Date() },
      },
      orderBy: { nextRetryAt: 'asc' },
      take: limit,
      select: { id: true, webhookId: true },
    })
  }

  /**
   * Mark a delivery as exhausted (the
   * retry budget is up). Used by the cron
   * worker when retryCount >= 3.
   */
  async markExhausted(deliveryId: string, lastError: string): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'exhausted',
        errorMessage: lastError,
        nextRetryAt: null,
      },
    })
  }

  /**
   * Manually re-deliver a past event.
   *
   * Use case: the receiver was down
   * for 2 hours, missed 47 events, the
   * retry budget (3 attempts) is
   * exhausted, and the operator wants
   * to replay the events now that the
   * receiver is back up.
   *
   * Behavior:
   *   1. Load the original delivery row.
   *      Reject if it doesn't belong to
   *      the caller's company (defense
   *      in depth — the controller also
   *      checks, but the service runs in
   *      the same PrismaClient).
   *   2. Check the webhook is still
   *      active. If the webhook was
   *      deleted or paused, the
   *      operator must re-enable it
   *      before re-delivery can succeed.
   *   3. Bump retryCount (we don't reset
   *      it — the retry budget is per
   *      ATTEMPT, so the next natural
   *      failure has the correct budget
   *      remaining).
   *   4. Create a NEW delivery row
   *      (status='pending', retryCount=0)
   *      that mirrors the original event
   *      payload. This keeps the audit
   *      trail clean: the original row
   *      stays as-is (showing what
   *      actually happened at the time),
   *      and the replay is a separate
   *      row that operators can scroll
   *      through.
   *
   * We don't reuse the existing
   * delivery row because:
   *   - Overwriting it would lose the
   *     original failure context
   *     (statusCode, errorMessage,
   *     responseBody)
   *   - Replay is a distinct operator
   *     action ("I'm deliberately
   *     re-firing this") — keeping it
   *     as a separate row makes the
   *     audit trail easier to read
   *   - The retry worker skips rows
   *     with status='exhausted', so
   *     updating the existing row
   *     would either re-trigger the
   *     worker (wrong) or require
   *     extra branching (wrong)
   *
   * Why not just call retryDelivery()
   * on the existing row?
   *   - retryDelivery() only fires on
   *     status='failed'. An exhausted
   *     row would 404. A success row
   *     would also 404. Only failed
   *     rows can be replayed via that
   *     path. This API supports
   *     replaying ANY past event,
   *     regardless of its prior status
   *     — which is what an operator
   *     wants ("replay that event
   *     from yesterday", not "retry
   *     the latest failure").
   *
   * Returns the new delivery row.
   * The caller (controller) returns
   * the id so the UI can refresh the
   * deliveries list.
   */
  async replayDelivery(deliveryId: string, companyId: string) {
    const original = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true },
    })
    if (!original) {
      throw new NotFoundException(
        `Delivery ${deliveryId} not found`,
      )
    }
    // Tenant isolation: only allow
    // replaying deliveries for the
    // caller's company. Even though
    // the controller also filters by
    // companyId, this guards against
    // accidental cross-tenant access
    // if someone calls the service
    // directly (e.g. from another
    // controller).
    if (original.companyId !== companyId) {
      throw new NotFoundException(
        `Delivery ${deliveryId} not found`,
      )
    }
    if (!original.webhook || original.webhook.status !== 'active') {
      throw new BadRequestException(
        'Webhook is not active — pause/resume it before replaying',
      )
    }
    // Build the event from the stored
    // payload. The payload was JSON-
    // serialized when we POSTed it
    // originally, so it's a plain
    // object now (no Date objects,
    // no BigInts).
    const event = original.payload as unknown as WebhookEvent

    // Bump the original delivery's
    // retryCount so the audit trail
    // shows "this event has been
    // retried N times". The new
    // delivery row starts at 0.
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { retryCount: { increment: 1 } },
    })

    // Create a new delivery row for
    // the replay. We use a fresh id
    // (default UUID) and keep the
    // original eventId — receivers
    // dedupe on eventId, so a replay
    // with the same eventId is
    // treated as the same event. This
    // matches Stripe / GitHub /
    // standard webhook idempotency
    // semantics.
    const replay = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: original.webhookId,
        companyId: original.companyId,
        eventType: original.eventType,
        eventId: original.eventId,
        payload: event as any,
        status: 'pending',
        // Note: we don't copy retryCount
        // — the replay starts at 0.
        // The bumped retryCount on the
        // original is the "this event
        // has been retried N times"
        // signal.
      },
    })
    // Fire the HTTP call (fire-and-
    // forget — same pattern as emit()).
    this.deliver(
      replay.id,
      original.webhook.url,
      original.webhook.secret,
      event,
    ).catch((err) => {
      this.logger.error(
        `webhook replay ${replay.id} failed: ${(err as Error).message}`,
      )
    })
    return replay
  }

  /**
   * Tier 198 — manually re-queue an
   * exhausted delivery.
   *
   * Use case: the receiver was down
   * for hours, every retry attempt hit
   * `exhausted`, the operator now knows
   * the receiver is back up, and they
   * want the existing row to be picked
   * up by the retry cron again WITHOUT
   * creating a brand-new delivery row.
   *
   * vs. `replayDelivery()`:
   *   - replay = create a fresh row
   *     (audit-clean: original stays
   *     as-is, replay shows up as a
   *     distinct attempt the operator
   *     can scroll to).
   *   - requeue = reset the SAME row
   *     back to "failed, due now",
   *     which the cron worker will
   *     re-attempt with the next tick.
   *
   * Why both? Different operator
   * intent. Replay = "I want a fresh
   * attempt, side-by-side with the
   * failures". Requeue = "I just want
   * the dead-letter to disappear
   * from the queue — the receiver is
   * up, retry it". For 1-3 failed
   * events, replay is more readable.
   * For 47 dead-letters after an
   * outage, requeue is faster than
   * clicking 47 replay buttons.
   *
   * Behavior:
   *   1. Load the row. Reject if not
   *      found or not in the caller's
   *      company.
   *   2. Reject if status !== 'exhausted'
   *      — requeue only makes sense for
   *      the dead-letter status. For
   *      failed rows, the natural cron
   *      retry is already in flight; for
   *      pending, the row is fresh.
   *   3. Reject if the webhook is
   *      paused / disabled / deleted.
   *   4. Reset retryCount=0, status='failed',
   *      nextRetryAt=now() (so the cron
   *      picks it up on the next tick).
   *      We clear statusCode / errorMessage
   *      so the row's last-known-state
   *      reflects the prior exhaustion
   *      only via the audit history.
   *
   * Returns the reset row.
   */
  async requeueDelivery(deliveryId: string, companyId: string) {
    const row = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true },
    })
    if (!row) {
      throw new NotFoundException(
        `Delivery ${deliveryId} not found`,
      )
    }
    if (row.companyId !== companyId) {
      throw new NotFoundException(
        `Delivery ${deliveryId} not found`,
      )
    }
    if (row.status !== 'exhausted') {
      throw new BadRequestException(
        `Delivery ${deliveryId} is ${row.status}, not exhausted — only dead-letter rows can be requeued`,
      )
    }
    if (!row.webhook || row.webhook.status !== 'active') {
      throw new BadRequestException(
        `Webhook ${row.webhookId} is not active — re-enable it before requeuing the dead-letter`,
      )
    }
    return this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'failed',
        retryCount: 0,
        nextRetryAt: new Date(),
        // Clear the stale error — the
        // next attempt will write its
        // own statusCode / errorMessage.
        errorMessage: null,
        statusCode: null,
      },
    })
  }

  /**
   * Tier 198 — list all dead-letter
   * (exhausted) deliveries for the
   * caller's company. Used by the
   * dashboard's "Dead-Letter Queue"
   * section.
   *
   * Tier 201 — added optional
   * `eventType` filter so the operator
   * can scope the cross-webhook view
   * to a single event type
   * (e.g. "show me all `payment.received`
   * dead-letters, not `invoice.created`").
   * When omitted, all event types are
   * returned.
   *
   * Returns up to `limit` rows ordered
   * by attemptedAt desc (most-recent
   * first — same convention as the
   * per-webhook deliveries list).
   */
  async listDeadLetter(companyId: string, limit = 100, eventType?: string) {
    const where: any = { companyId, status: 'exhausted' }
    if (eventType) where.eventType = eventType
    return this.prisma.webhookDelivery.findMany({
      where,
      orderBy: { attemptedAt: 'desc' },
      take: Math.min(limit, 200),
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
        webhook: {
          select: { name: true, url: true },
        },
      },
    })
  }

  async deliver(
    deliveryId: string,
    url: string,
    secret: string,
    event: WebhookEvent,
  ): Promise<void> {
    const body = JSON.stringify({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      companyId: event.companyId,
      data: event.data,
    })
    const signature = WebhookService.sign(secret, body)
    const start = Date.now()
    try {
      const res = await this.postJson(url, body, signature, 10_000)
      const duration = Date.now() - start
      // 2xx → success; 4xx → permanent
      // failure (don't retry); 5xx →
      // failed (retry).
      let status: 'success' | 'failed' | 'exhausted'
      if (res.statusCode >= 200 && res.statusCode < 300) {
        status = 'success'
      } else if (res.statusCode >= 400 && res.statusCode < 500) {
        // 4xx is "you sent something
        // wrong, don't retry". Common
        // 401/403 cases: receiver's
        // signature verification
        // failed, or the URL is gated.
        status = 'failed'
      } else {
        status = 'failed'
      }
      // Read current retryCount so we
      // can decide if THIS 5xx attempt
      // exhausted the budget.
      const currentRetryCount = await this.getRetryCount(deliveryId)
      const isExhausted = status === 'failed' && res.statusCode >= 500 && currentRetryCount >= 3
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: isExhausted ? 'exhausted' : status,
          statusCode: res.statusCode,
          responseBody: (res.body || '').slice(0, 4_000),
          durationMs: duration,
          // Schedule retry on 5xx / network
          // error, ONLY if we haven't
          // exhausted the budget. 4xx is
          // "don't retry" (the receiver
          // said the request was bad).
          nextRetryAt: status === 'failed' && res.statusCode >= 500 && !isExhausted
            ? this.nextRetryAt(currentRetryCount)
            : null,
        },
      })
    } catch (err) {
      const duration = Date.now() - start
      const errMsg = (err as Error).message
      // Network error / timeout
      const retryCount = await this.getRetryCount(deliveryId)
      const isExhausted = retryCount >= 3
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: isExhausted ? 'exhausted' : 'failed',
          statusCode: null,
          durationMs: duration,
          errorMessage: errMsg,
          nextRetryAt: isExhausted ? null : this.nextRetryAt(retryCount),
        },
      })
      this.logger.warn(
        `webhook delivery ${deliveryId} failed (attempt ${retryCount + 1}/3): ${errMsg}`,
      )
    }
  }

  private nextRetryAt(retryCount: number): Date {
    // Exponential backoff: 1min, 5min,
    // 30min. After 3 retries, give up
    // (status='exhausted').
    const minutes = [1, 5, 30][Math.min(retryCount, 2)]
    return new Date(Date.now() + minutes * 60_000)
  }

  private async getRetryCount(deliveryId: string): Promise<number> {
    const d = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      select: { retryCount: true },
    })
    return d?.retryCount ?? 0
  }

  /**
   * HTTP POST with a 10s timeout. Uses
   * the global `fetch` (Node 18+). We
   * don't go through axios or any
   * other client — the global fetch
   * has built-in timeouts, AbortController,
   * and HTTPS support. The receiver's
   * self-signed cert (if any) will
   * fail; that's intentional — TLS
   * verification is the receiver's
   * responsibility.
   */
  private async postJson(
    url: string,
    body: string,
    signature: string,
    timeoutMs: number,
  ): Promise<{ statusCode: number; body: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': `sha256=${signature}`,
          'X-Webhook-Id': 'de-invoice',
          'User-Agent': 'de-invoice-webhook/1.0',
        },
        body,
        signal: controller.signal,
      })
      const responseBody = await res.text()
      return { statusCode: res.status, body: responseBody }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Tier 203 — webhook deliveries CSV
   * export. Operator pulls the last N
   * days of delivery rows into Excel
   * for the Berater.
   *
   * The columns are stable and
   * machine-readable so a future
   * "import into Excel" workflow
   * can rely on the header order:
   *   id, webhookId, webhookName,
   *   eventType, eventId, status,
   *   statusCode, durationMs,
   *   retryCount, errorMessage,
   *   attemptedAt, nextRetryAt
   *
   * The webhookName is joined in (a
   * second small query) so the
   * Berater can read the export
   * without cross-referencing the
   * webhooks list — same shape as
   * the dead-letter list endpoint
   * (Tier 198).
   *
   * We cap the row count at 10,000
   * to keep the export reasonable
   * for the operator's "last 90
   * days" use case. If you have
   * > 10k deliveries in 90 days
   * for one company, you're
   * probably doing something
   * pathological — the export
   * returns the first 10k and the
   * CSV includes a trailing
   * `# truncated: ...` comment.
   *
   * @param days 1..365 (capped at
   *   365 to keep the query small;
   *   default 90).
   * @param eventType optional event
   *   type filter (matches the
   *   delivery drawer filter).
   * @param status optional status
   *   filter (success/failed/exhausted/pending).
   */
  async exportDeliveriesCsv(
    companyId: string,
    days = 90,
    eventType?: string,
    status?: string,
  ): Promise<string> {
    const daysClamped = Math.min(Math.max(days, 1), 365)
    const cutoff = new Date(
      Date.now() - daysClamped * 24 * 60 * 60 * 1000,
    )
    const where: any = { companyId, attemptedAt: { gte: cutoff } }
    if (eventType) where.eventType = eventType
    if (status) where.status = status
    const [rows, webhooks] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where,
        orderBy: { attemptedAt: 'desc' },
        take: 10_000,
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
      }),
      this.prisma.webhook.findMany({
        where: { companyId },
        select: { id: true, name: true },
      }),
    ])
    const nameById = new Map(webhooks.map((w) => [w.id, w.name]))
    // RFC 4180 CSV escaping. Wrap any
    // field that contains a comma,
    // quote, or newline in double
    // quotes and double-up any
    // embedded quotes.
    const esc = (v: any): string => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      if (/[",\n\r]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"'
      }
      return s
    }
    const header = [
      'id',
      'webhookId',
      'webhookName',
      'eventType',
      'eventId',
      'status',
      'statusCode',
      'durationMs',
      'retryCount',
      'errorMessage',
      'attemptedAt',
      'nextRetryAt',
    ]
    const lines: string[] = [header.map(esc).join(',')]
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.webhookId,
          nameById.get(r.webhookId) || '',
          r.eventType,
          r.eventId,
          r.status,
          r.statusCode ?? '',
          r.durationMs ?? '',
          r.retryCount,
          r.errorMessage ?? '',
          r.attemptedAt.toISOString(),
          r.nextRetryAt ? r.nextRetryAt.toISOString() : '',
        ]
          .map(esc)
          .join(','),
      )
    }
    if (rows.length === 10_000) {
      // Truncation marker so the
      // operator knows they hit the
      // cap. Use a `# ` prefix so
      // Excel treats it as a comment
      // (Excel skips rows starting
      // with `#` when importing as
      // delimited CSV).
      lines.push(
        `# truncated: hit 10,000-row cap. Narrow the days/eventType/status filter to export more.`,
      )
    }
    return lines.join('\n') + '\n'
  }
}

/**
 * Reject non-http(s) URLs and URLs to
 * private IP ranges. Same SSRF guard
 * logic as the FinTS endpoint (Tier 12
 * §39) — we don't want a webhook
 * creation to allow probing the
 * internal network.
 */
function isValidUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false
  }
  // Block private IPs
  const host = parsed.hostname
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
  ) {
    return false
  }
  return true
}
