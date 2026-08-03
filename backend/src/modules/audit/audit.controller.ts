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
