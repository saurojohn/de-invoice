import {
  Controller,
  Get,
  Query,
  Param,
  Res,
  Header,
  BadRequestException,
} from '@nestjs/common'
import type { Response } from 'express'
import { AuditService, AuditLogFilters } from './audit.service'
import { Auth, Require } from '../../auth/roles.decorator'

/**
 * Tier 67: Audit-Trail HTTP API.
 *
 * Endpoints (all require `audit.read`, which maps
 * to the `accountant` role — so a `viewer` cannot
 * see who changed what; admin + accountant + berater
 * can):
 *
 *   GET /api/v1/audit-logs
 *     ?companyId=...&entityType=Invoice&userId=...
 *     &action=invoice.updated&dateFrom=...&dateTo=...
 *     &skip=0&take=50
 *     → { rows, total, take, skip }
 *
 *   GET /api/v1/audit-logs/stats?companyId=...
 *     → { totalActions, byAction, byEntityType,
 *         byUser, newestChange }
 *
 *   GET /api/v1/audit-logs/:id?companyId=...
 *     → { id, action, entityType, entityId, userId,
 *         userEmail, ipAddress, oldData, newData, … }
 *     404 if not found
 *
 *   GET /api/v1/audit-logs-export.csv?companyId=...
 *     → text/csv (Content-Disposition: attachment)
 *
 * The endpoints are read-only. There is no POST /
 * PATCH / DELETE — the AuditLog is append-only by
 * GoBD design.
 */
@Auth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Get()
  @Require('audit.read')
  async list(
    @Query('companyId') companyId: string,
    @Query('entityType') entityType?: string,
    // Tier 122: comma-separated lists for multi-select
    // (e.g. `?entities=Invoice,Customer`).
    @Query('entities') entities?: string,
    @Query('entityId') entityId?: string,
    @Query('userId') userId?: string,
    @Query('userIds') userIds?: string,
    @Query('action') action?: string,
    @Query('actions') actions?: string,
    @Query('actionPrefix') actionPrefix?: string,
    @Query('actionPrefixes') actionPrefixes?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    // Tier 143: free-text search. Hits action,
    // entityType, entityId, user.email, newData,
    // oldData — case-insensitive on the text fields,
    // substring on the jsonb blobs.
    @Query('q') q?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const f = parseFilters({
      companyId,
      entityType,
      entities,
      entityId,
      userId,
      userIds,
      action,
      actions,
      actionPrefix,
      actionPrefixes,
      q,
      dateFrom,
      dateTo,
      skip,
      take,
    })
    return this.svc.list(f)
  }

  @Get('stats')
  @Require('audit.read')
  async stats(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.stats(companyId)
  }

  @Get('export.csv')
  @Require('audit.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('entityType') entityType?: string,
    @Query('entities') entities?: string,
    @Query('entityId') entityId?: string,
    @Query('userId') userId?: string,
    @Query('userIds') userIds?: string,
    @Query('action') action?: string,
    @Query('actions') actions?: string,
    @Query('actionPrefix') actionPrefix?: string,
    @Query('actionPrefixes') actionPrefixes?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('q') q?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const f = parseFilters({
      companyId,
      entityType,
      entities,
      entityId,
      userId,
      userIds,
      action,
      actions,
      actionPrefix,
      actionPrefixes,
      q,
      dateFrom,
      dateTo,
    })
    const csv = await this.svc.exportCsv(f)
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-log-${stamp}.csv"`,
    )
    // BOM so Excel correctly detects UTF-8 (German
    // umlauts in entityType / JSON values would
    // otherwise render as mojibake).
    res.send('\ufeff' + csv)
  }

  /**
   * Tier 196 — walk the entire audit-log hash
   * chain for a company and report the first
   * broken link. Returns:
   *   {
   *     ok:        boolean,
   *     totalRows: number,
   *     verifiedRows: number,
   *     brokenAt: { id, createdAt, expectedHash,
   *                 actualHash, reason } | null,
   *     algorithm: string,
   *     verifiedAt: string,
   *   }
   *
   * 200 always. The caller inspects `ok` + `brokenAt`
   * to decide whether to render a green badge or
   * a red alert. The endpoint is read-only and
   * safe to call from the dashboard widget —
   * it scans at most a few thousand rows and
   * the loop is in-memory.
   *
   * `ok=true` means every row in the chain
   * re-derives to the same hash AND every
   * row's previousHash matches the previous
   * row's hash. `ok=false` with `brokenAt`
   * non-null means the chain is broken at that
   * row.
   */
  /**
   * Tier 202 — list activity-log rows
   * (operator actions like
   * `error.resolve_all`,
   * `webhook.requeue`,
   * `cron.run_manually`, etc).
   *
   * Implemented as a thin filter on
   * top of the existing audit list:
   * `actionPrefixes=["error.", "webhook.", "cron.", "notification."]`
   * restricts the result to the
   * activity subset without a new
   * endpoint. The Berater page hits
   * this with `take=200` and the
   * standard filters (actor, action
   * range).
   *
   * Cross-company actions (cron
   * manual runs, recorded with
   * `companyId=null`) are ALSO
   * included — admins need to see
   * them in the activity feed even
   * if their companyId doesn't match.
   * We OR the companyId filter with
   * `companyId IS NULL` at the
   * service level via
   * `includeNullCompanyId: true`
   * (see list()).
   *
   * The 4 prefixes match the
   * `writeActivity` action-naming
   * convention. New admin actions
   * should pick a prefix that aligns
   * with the entity they mutate
   * (e.g. `backup.run_manual` would
   * be a new prefix).
   */
  @Get('activity')
  @Require('audit.read')
  async listActivity(
    @Query('companyId') companyId: string,
    @Query('userId') userId?: string,
    @Query('actionPrefix') actionPrefix?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    // Default to the full union of
    // activity prefixes. The
    // Berater page can narrow with
    // a single `actionPrefix`
    // (e.g. `error.`).
    const prefixes = actionPrefix
      ? [actionPrefix]
      : ['error.', 'webhook.', 'cron.', 'notification.']
    return this.svc.list({
      companyId,
      includeNullCompanyId: true, // see Tier 202 note
      userIds: userId ? [userId] : undefined,
      actionPrefixes: prefixes,
      take: Math.min(parseInt(take || '100', 10) || 100, 500),
      skip: parseInt(skip || '0', 10) || 0,
    })
  }

  /**
   * Tier 204 — activity-log CSV export.
   * Same filters as the listActivity
   * endpoint (Tier 202) but returns
   * a CSV body the Berater can
   * download and open in Excel.
   *
   * URL: GET /audit-logs/activity.csv
   *
   * Query:
   *   - companyId (required)
   *   - days (optional, default 90,
   *     capped at 365)
   *   - actionPrefix (optional
   *     single-prefix filter, e.g.
   *     "error.")
   *   - userId (optional actor
   *     filter)
   *
   * Returns RFC 4180-compliant CSV
   * with a UTF-8 BOM (so Excel
   * correctly detects UTF-8) and
   * a `Content-Disposition:
   * attachment` header. The
   * delimiter is `;` to match the
   * existing audit export (Excel
   * DE default).
   *
   * Why a separate endpoint (not
   * just "?format=csv" on
   * /activity): same rationale as
   * Tier 203 (deliveries.csv) —
   * the CSV payload can be up to
   * 10k rows; the route is
   * registered separately so the
   * JSON endpoint stays fast.
   *
   * RBAC: same as /activity —
   * `audit.read` (Berater
   * permission).
   */
  @Get('activity.csv')
  @Require('audit.read')
  async exportActivityCsv(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('days') daysStr?: string,
    @Query('actionPrefix') actionPrefix?: string,
    @Query('userId') userId?: string,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const days = Math.min(
      Math.max(parseInt(daysStr || '90', 10) || 90, 1),
      365,
    )
    const csv = await this.svc.exportActivityCsv(
      companyId,
      days,
      actionPrefix,
      userId,
    )
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="activity-log-${stamp}.csv"`,
    )
    // BOM so Excel correctly
    // detects UTF-8. Same pattern
    // as the audit export
    // (Tier 67) and the webhook
    // deliveries export
    // (Tier 203).
    res.send('\ufeff' + csv)
  }

  @Get('verify')
  @Require('audit.read')
  async verifyChain(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.svc.verifyChain(companyId)
  }

  /**
   * Tier 196 — verify a single audit row. Re-derives
   * the hash from the row's current state and asserts
   * equality with the stored hash. Returns
   *   {
   *     id, signed, verified, algorithm,
   *     storedHash, recomputedHash, verifiedAt
   *   }
   *
   * 200 with verified=false (rather than 4xx) when
   * the row's stored hash doesn't match — the
   * caller (audit detail modal) renders a red
   * "tamper detected" badge.
   */
  @Get(':id/verify')
  @Require('audit.read')
  async verifyOne(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!id) throw new BadRequestException('id ist erforderlich')
    return this.svc.verifyOne(companyId, id)
  }

  @Get(':id')
  @Require('audit.read')
  async getOne(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!id) throw new BadRequestException('id ist erforderlich')
    const row = await this.svc.getOne(companyId, id)
    if (!row) {
      // NestJS @Get(':id') matches concrete paths
      // first, so this only fires when `id` is a
      // UUID-shaped string that doesn't exist.
      // We return null and let the controller
      // translate that to 404 via a custom
      // exception if needed; for now the
      // standard pattern is to throw.
      throw new BadRequestException('Audit-Eintrag nicht gefunden')
    }
    return row
  }
}

function parseFilters(raw: {
  companyId: string
  entityType?: string
  entities?: string
  entityId?: string
  userId?: string
  userIds?: string
  action?: string
  actions?: string
  actionPrefix?: string
  actionPrefixes?: string
  q?: string
  dateFrom?: string
  dateTo?: string
  skip?: string
  take?: string
}): AuditLogFilters {
  const f: AuditLogFilters = { companyId: raw.companyId }
  if (raw.entityType) f.entityType = raw.entityType
  // Tier 122: comma-separated multi-select
  if (raw.entities) {
    const list = raw.entities
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (list.length > 0) f.entityIds = list
  }
  if (raw.entityId) f.entityId = raw.entityId
  if (raw.userId) f.userId = raw.userId
  if (raw.userIds) {
    const list = raw.userIds
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (list.length > 0) f.userIds = list
  }
  if (raw.action) f.action = raw.action
  if (raw.actions) {
    const list = raw.actions
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (list.length > 0) f.actions = list
  }
  if (raw.actionPrefix) f.actionPrefix = raw.actionPrefix
  if (raw.actionPrefixes) {
    const list = raw.actionPrefixes
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (list.length > 0) f.actionPrefixes = list
  }
  // Tier 143: free-text search. Trim so a stray
  // space from the URL doesn't match every row.
  if (raw.q && raw.q.trim().length > 0) f.q = raw.q.trim()
  if (raw.dateFrom) {
    const d = new Date(raw.dateFrom)
    if (Number.isNaN(d.getTime()))
      throw new BadRequestException('Ungültiges dateFrom')
    f.dateFrom = d
  }
  if (raw.dateTo) {
    const d = new Date(raw.dateTo)
    if (Number.isNaN(d.getTime()))
      throw new BadRequestException('Ungültiges dateTo')
    f.dateTo = d
  }
  if (raw.skip) {
    const n = parseInt(raw.skip, 10)
    if (Number.isNaN(n) || n < 0)
      throw new BadRequestException('Ungültiger skip')
    f.skip = n
  }
  if (raw.take) {
    const n = parseInt(raw.take, 10)
    if (Number.isNaN(n) || n < 1 || n > 200)
      throw new BadRequestException('Ungültiger take (1-200)')
    f.take = n
  }
  return f
}
