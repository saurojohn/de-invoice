import {
  Injectable,
  BadRequestException,
} from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Prisma } from '@prisma/client'

/**
 * Tier 67: Audit-Trail read API.
 *
 * The AuditLog table is auto-populated by the Prisma
 * extension (prisma/audit-log.extension.ts) on every
 * update / delete of a GoBD-relevant model. This
 * service exposes a read-only view of that data:
 *
 *   - list()  — paginated, filterable
 *   - stats() — counts by action / entityType / user
 *   - getOne() — full detail of a single row (oldData,
 *                newData JSON) for the diff modal
 *   - exportCsv() — GoBD-grade CSV export of the
 *                   same filters as list()
 *
 * No write endpoints. The audit log is append-only —
 * there is intentionally no "delete an audit row" path.
 *
 * Why a separate "audit" module instead of stuffing
 * this into reports/: the reports module is heavy
 * (DATEV, UStVA, aging, cost-centers) and audit is
 * semantically distinct — it's the system-wide
 * "what changed?" log, not a financial report.
 */

export interface AuditLogFilters {
  companyId: string
  entityType?: string
  entityIds?: string[] // Tier 122: multi-select entity types
  entityId?: string
  userId?: string
  userIds?: string[] // Tier 122: multi-select users
  action?: string
  actions?: string[] // Tier 122: multi-select exact actions (CREATE/UPDATE/DELETE/...)
  actionPrefix?: string // e.g. "invoice." matches invoice.updated, invoice.created, …
  actionPrefixes?: string[] // Tier 122: multiple action prefixes
  q?: string // Tier 143: free-text search across action, entityId, user.email, newData, oldData
  dateFrom?: Date
  dateTo?: Date
  skip?: number
  take?: number
}

const MAX_TAKE = 200

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /**
   * Build the Prisma `where` from the filter DTO.
   * Helper, kept private-ish so list() and stats()
   * and exportCsv() share one source of truth.
   *
   * Tier 122: also accepts arrays — entityIds[],
   * userIds[], actions[], actionPrefixes[] — for
   * the new multi-select filters on the audit page.
   * An empty array is treated as "not set" so the
   * caller can pass `[]` without breaking the query.
   */
  private buildWhere(f: AuditLogFilters): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {
      companyId: f.companyId,
    }
    // Entity type: single takes precedence; otherwise
    // the multi-select array. If both are set, we honour
    // the array (caller's intent is "filter by these").
    if (f.entityIds && f.entityIds.length > 0) {
      where.entityType = { in: f.entityIds }
    } else if (f.entityType) {
      where.entityType = f.entityType
    }
    if (f.entityId) where.entityId = f.entityId
    // User: same precedence as entityType.
    if (f.userIds && f.userIds.length > 0) {
      where.userId = { in: f.userIds }
    } else if (f.userId) {
      where.userId = f.userId
    }
    // Action: exact match, multi, then prefix, then
    // multi-prefix. The Prisma `action` field is a
    // String column, so we use AND across the
    // startsWith variants by combining them into the
    // `where` directly (Prisma's top-level where is
    // implicitly ANDed across keys). For the multi-
    // prefix case we fall back to a single startsWith
    // — exact action takes precedence when both
    // `actions` and `actionPrefixes` are empty arrays.
    if (f.actions && f.actions.length > 0) {
      where.action = { in: f.actions }
    } else if (f.action) {
      where.action = f.action
    } else if (f.actionPrefixes && f.actionPrefixes.length > 0) {
      // Tier 135: multi-prefix with OR semantics.
      // Prisma's top-level `where.action` only
      // accepts one expression, so we drop it and
      // use `where.OR` with a startsWith per prefix.
      // We can't combine this with other where.action
      // expressions, but the else-if chain above
      // guarantees this branch is exclusive.
      where.OR = f.actionPrefixes.map((p) => ({
        action: { startsWith: p },
      }))
    } else if (f.actionPrefix) {
      where.action = { startsWith: f.actionPrefix }
    }
    if (f.dateFrom || f.dateTo) {
      where.createdAt = {}
      if (f.dateFrom) where.createdAt.gte = f.dateFrom
      if (f.dateTo) where.createdAt.lte = f.dateTo
    }
    // NOTE: the free-text `q` filter (Tier 143) is NOT
    // applied here. list() routes to a dedicated
    // raw-SQL path when q is set because Prisma 5.22's
    // string_contains on Json columns is broken (it
    // adds JSONB_TYPEOF(...) = 'string' which never
    // matches our newData/oldData objects). The raw
    // SQL path casts jsonb → text and runs ILIKE.
    return where
  }

  /**
   * Paginated list. The list is always sorted by
   * `createdAt DESC` — most-recent first. The
   * `total` field lets the UI render "Showing 1-50
   * of 1770" and decide whether to show "next".
   *
   * Tier 143: when `f.q` is set, we bypass Prisma's
   * findMany and go straight to raw SQL. Prisma 5.22's
   * `string_contains` on Json columns is broken — it
   * adds a `JSONB_TYPEOF(...) = 'string'` clause that
   * never matches because our newData/oldData are
   * always objects. The raw SQL casts the jsonb to
   * text and runs ILIKE, which Postgres does natively
   * across the entire JSON tree.
   *
   * Everything else (date range, action prefix, etc.)
   * still flows through buildWhere + Prisma's
   * findMany for the no-q case. The two paths share
   * the same response shape.
   */
  async list(f: AuditLogFilters) {
    const take = Math.min(f.take ?? 50, MAX_TAKE)
    const skip = Math.max(f.skip ?? 0, 0)
    if (f.q && f.q.trim().length > 0) {
      return this.listWithTextSearch(f, take, skip)
    }
    const where = this.buildWhere(f)
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          userId: true,
          ipAddress: true,
          createdAt: true,
          // user email for the "who" column
          user: { select: { email: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ])
    return {
      rows: rows.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userId: r.userId,
        userEmail: r.user?.email ?? null,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt,
      })),
      total,
      take,
      skip,
    }
  }

  /**
   * Tier 143: full-text search path. Uses raw SQL
   * because Prisma's jsonb string_contains is broken
   * in 5.22 (see list() above for the gory details).
   *
   * The query:
   *   1. Reuses buildWhere for the structural
   *      filters (entityType, actionPrefix, date, ...)
   *      — we serialise them as raw SQL fragments.
   *   2. Adds the q search as ILIKE across action,
   *      entityType, entityId, newData, oldData, and
   *      a subquery on User.email.
   *   3. Joins to User to populate userEmail in the
   *      same round-trip (saves a Prisma follow-up).
   *
   * Postgres handles the jsonb→text cast efficiently
   * — it's a one-off conversion per row, then a
   * standard LIKE on the result. For tables up to
   * ~100k rows this is fast enough without a GIN
   * index on the jsonb expression.
   */
  private async listWithTextSearch(
    f: AuditLogFilters,
    take: number,
    skip: number,
  ): Promise<{
    rows: any[]
    total: number
    take: number
    skip: number
  }> {
    const q = f.q!.trim()
    const where = this.buildWhere(f)
    // Convert Prisma where to SQL fragments.
    // We intentionally keep this conservative: only
    // the fields the UI actually sends are translated.
    // Anything exotic would need explicit handling.
    const params: any[] = []
    const fragments: string[] = []
    params.push(f.companyId)
    fragments.push(`al."companyId" = $${params.length}`)
    if (f.entityIds && f.entityIds.length > 0) {
      const placeholders = f.entityIds.map((_, i) => `$${params.length + i}`).join(',')
      f.entityIds.forEach((v) => params.push(v))
      fragments.push(`al."entityType" IN (${placeholders})`)
    } else if (f.entityType) {
      params.push(f.entityType)
      fragments.push(`al."entityType" = $${params.length}`)
    }
    if (f.entityId) {
      params.push(f.entityId)
      fragments.push(`al."entityId" = $${params.length}`)
    }
    if (f.userIds && f.userIds.length > 0) {
      const placeholders = f.userIds.map((_, i) => `$${params.length + i}`).join(',')
      f.userIds.forEach((v) => params.push(v))
      fragments.push(`al."userId" IN (${placeholders})`)
    } else if (f.userId) {
      params.push(f.userId)
      fragments.push(`al."userId" = $${params.length}`)
    }
    if (f.actions && f.actions.length > 0) {
      const placeholders = f.actions.map((_, i) => `$${params.length + i}`).join(',')
      f.actions.forEach((v) => params.push(v))
      fragments.push(`al."action" IN (${placeholders})`)
    } else if (f.action) {
      params.push(f.action)
      fragments.push(`al."action" = $${params.length}`)
    } else if (f.actionPrefixes && f.actionPrefixes.length > 0) {
      // OR across the prefixes (matches buildWhere).
      const orParts = f.actionPrefixes.map((p) => {
        params.push(`${p}%`)
        return `al."action" LIKE $${params.length}`
      })
      fragments.push(`(${orParts.join(' OR ')})`)
    } else if (f.actionPrefix) {
      params.push(`${f.actionPrefix}%`)
      fragments.push(`al."action" LIKE $${params.length}`)
    }
    if (f.dateFrom) {
      params.push(f.dateFrom)
      fragments.push(`al."createdAt" >= $${params.length}`)
    }
    if (f.dateTo) {
      params.push(f.dateTo)
      fragments.push(`al."createdAt" <= $${params.length}`)
    }

    // The q search. We use a single $N for the pattern
    // so all fields search for the same substring.
    // `::text` casts jsonb → text so ILIKE works
    // (Postgres' jsonb doesn't have a built-in LIKE
    // operator).
    params.push(`%${q}%`)
    const qIdx = params.length
    const qFrag = [
      `al."action" ILIKE $${qIdx}`,
      `al."entityType" ILIKE $${qIdx}`,
      `al."entityId"::text ILIKE $${qIdx}`,
      `al."newData"::text ILIKE $${qIdx}`,
      `al."oldData"::text ILIKE $${qIdx}`,
      `u.email ILIKE $${qIdx}`,
    ].join(' OR ')
    fragments.push(`(${qFrag})`)

    const whereClause = fragments.join(' AND ')

    // Two parallel queries: count + page.
    const [countRows, dataRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint as count
         FROM "AuditLog" al
         LEFT JOIN "User" u ON u.id = al."userId"
         WHERE ${whereClause}`,
        ...params,
      ),
      this.prisma.$queryRawUnsafe<Array<any>>(
        `SELECT al.id, al.action, al."entityType", al."entityId",
                al."userId", al."ipAddress", al."createdAt",
                u.email as "userEmail"
         FROM "AuditLog" al
         LEFT JOIN "User" u ON u.id = al."userId"
         WHERE ${whereClause}
         ORDER BY al."createdAt" DESC
         LIMIT ${take} OFFSET ${skip}`,
        ...params,
      ),
    ])
    return {
      rows: dataRows.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userId: r.userId,
        userEmail: r.userEmail,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt,
      })),
      total: Number(countRows[0]?.count ?? 0),
      take,
      skip,
    }
  }

  /**
   * Summary stats: counts by action / entityType /
   * user, plus the date of the most recent change.
   * Drives the "Audit-Trail Übersicht" cards on
   * the dashboard.
   */
  async stats(companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const baseWhere: Prisma.AuditLogWhereInput = { companyId }

    // Three parallel groupBy queries + a single
    // "newest" query.
    const [byAction, byEntityType, byUser, newest] = await Promise.all([
      this.prisma.auditLog.groupBy({
        by: ['action'],
        where: baseWhere,
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
        take: 20,
      }),
      this.prisma.auditLog.groupBy({
        by: ['entityType'],
        where: baseWhere,
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
        take: 20,
      }),
      this.prisma.auditLog.groupBy({
        by: ['userId'],
        where: baseWhere,
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      this.prisma.auditLog.findFirst({
        where: baseWhere,
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ])
    return {
      totalActions: byAction.reduce((a, b) => a + b._count._all, 0),
      byAction: byAction.map((r) => ({
        action: r.action,
        count: r._count._all,
      })),
      byEntityType: byEntityType.map((r) => ({
        entityType: r.entityType ?? '(none)',
        count: r._count._all,
      })),
      byUser: byUser.map((r) => ({
        userId: r.userId,
        count: r._count._all,
      })),
      newestChange: newest?.createdAt ?? null,
    }
  }

  /**
   * Full row including the oldData / newData JSON.
   * Powers the diff modal — the before/after view
   * the auditor opens when they click a row in the
   * list.
   */
  async getOne(companyId: string, id: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!id) throw new BadRequestException('id ist erforderlich')
    const row = await this.prisma.auditLog.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        userId: true,
        ipAddress: true,
        userAgent: true,
        oldData: true,
        newData: true,
        createdAt: true,
        user: { select: { email: true } },
      },
    })
    if (!row) return null
    return {
      ...row,
      userEmail: row.user?.email ?? null,
    }
  }

  /**
   * CSV export. Returns a string — the controller
   * sets the Content-Type and Content-Disposition.
   *
   * Why a CSV (not a PDF): GoBD § 147 AO requires
   * a machine-readable export of the audit trail.
   * CSV is the lingua franca for that — every
   * tax-audit tool reads it, and the auditor can
   * verify the row count against the printed log.
   *
   * Columns: Zeitstempel, Aktion, Entität, Entity-ID,
   * Benutzer, IP, Alt-Daten, Neu-Daten. The JSON
   * columns are stringified and surrounded by
   * double-quotes; embedded newlines / quotes are
   * escaped per RFC 4180.
   */
  async exportCsv(f: AuditLogFilters): Promise<string> {
    // Tier 143: when q is set, route to the text-search
    // path so the jsonb fields are searched correctly.
    // Otherwise stick with the Prisma path (faster,
    // because no JOIN to User for the email).
    let rawRows: Array<{
      action: string
      entityType: string | null
      entityId: string | null
      userId: string | null
      ipAddress: string | null
      oldData: unknown
      newData: unknown
      createdAt: Date
      user?: { email: string | null } | null
      userEmail?: string | null
    }>
    if (f.q && f.q.trim().length > 0) {
      const page = await this.listWithTextSearch(f, 10_000, 0)
      // listWithTextSearch already returns userEmail
      // flat — fold it into a user-shaped stub so the
      // CSV row builder below is unchanged.
      rawRows = page.rows.map((r) => ({
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userId: r.userId,
        ipAddress: r.ipAddress,
        oldData: null, // list() doesn't return oldData/newData (payload)
        newData: null,
        createdAt: r.createdAt,
        user: { email: r.userEmail },
      }))
    } else {
      const where = this.buildWhere(f)
      rawRows = await this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 10_000, // cap — exports beyond 10k rows
                       // should be paginated via a
                       // background job, not a sync
                       // HTTP response
        select: {
          action: true,
          entityType: true,
          entityId: true,
          userId: true,
          ipAddress: true,
          oldData: true,
          newData: true,
          createdAt: true,
          user: { select: { email: true } },
        },
      })
    }
    const header = [
      'Zeitstempel',
      'Aktion',
      'Entitaet',
      'Entity-ID',
      'Benutzer',
      'IP',
      'Alt-Daten',
      'Neu-Daten',
    ]
    const lines: string[] = [header.map(esc).join(';')]
    for (const r of rawRows) {
      lines.push(
        [
          r.createdAt.toISOString(),
          r.action,
          r.entityType ?? '',
          r.entityId ?? '',
          r.user?.email ?? r.userId ?? '',
          r.ipAddress ?? '',
          r.oldData ? JSON.stringify(r.oldData) : '',
          r.newData ? JSON.stringify(r.newData) : '',
        ]
          .map(esc)
          .join(';'),
      )
    }
    return lines.join('\n')
  }
}

/** RFC 4180 CSV escape — wraps in double-quotes
 *  and doubles any embedded quote. */
function esc(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (s.includes('"') || s.includes(';') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}
