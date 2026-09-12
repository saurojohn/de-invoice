import {
  Injectable,
  BadRequestException,
} from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Prisma } from '@prisma/client'
import { createHash } from 'crypto'

/**
 * Tier 196 — hash function for the audit log
 * chain. Kept in sync with the same function
 * in prisma/audit-log.extension.ts. If you
 * change one, change both (and bump the
 * algorithm string).
 *
 * The hash input is a pipe-separated canonical
 * string of (action, entityType, entityId, userId,
 * companyId, oldData, newData, previousHash,
 * createdAt). JSON values are stringified with
 * stable key order so the write path and the
 * verify path produce the same input.
 */
const AUDIT_HASH_V1 = 'SHA-256-V1'
const AUDIT_HASH_ALGORITHM = 'SHA-256-V2'

// Tier 366: two canonicalisations, selected by the row's hashAlgorithm.
//
// V1 (everything written before Tier 366) walked objects with Object.keys()
// and only special-cased Date. That silently broke every audited model with a
// Prisma.Decimal column — Invoice, InvoiceItem, Expense, Voucher, Product,
// CashBookEntry, Account, JournalEntry, BankTransaction: on the WRITE path a
// Decimal is a live object whose own keys are ["constructor","s","e","d"], so
// the hash covered decimal.js internals (and "constructor" even serialised to
// the literal `undefined`), while the VERIFY path re-reads the same field from
// jsonb as the string "119". Same row, two different hash inputs — an
// untampered product.updated row verified as verified=false.
//
// V2 canonicalises each value to what jsonb actually stores: a Decimal to a
// JSON number (NOT its toJSON() string), a Date to its ISO string, and BigInt
// to a decimal string (JSON.stringify throws on BigInt, which would have
// crashed the audit write).
//
// V1 rows keep verifying under V1 rules, so history is not rewritten; rows
// containing a Decimal were already unverifiable and stay that way until
// scripts/audit-rehash.ts is run.
const stableStringifyV1 = (v: any): string => {
  if (v == null) return ''
  if (v instanceof Date) return JSON.stringify(v.toISOString())
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) {
    return '[' + v.map(stableStringifyV1).join(',') + ']'
  }
  const keys = Object.keys(v).sort()
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringifyV1(v[k]))
      .join(',') +
    '}'
  )
}

const stableStringifyV2 = (v: any): string => {
  if (v == null) return ''
  if (typeof v === 'bigint') return JSON.stringify(v.toString())
  if (typeof v !== 'object') return JSON.stringify(v)
  // Prisma writes a Decimal into a Json column as a JSON NUMBER (verified:
  // jsonb_typeof(newData->'basePrice') = number). Note JSON.stringify() on a
  // Decimal gives the STRING "19" instead — canonicalising via toJSON() would
  // hash "19" while the verify path reads the number 19.
  if (typeof (v as any).toNumber === 'function') {
    return JSON.stringify((v as any).toNumber())
  }
  // Date (and anything else with toJSON) is stored as its ISO string.
  if (typeof (v as any).toJSON === 'function') {
    return stableStringifyV2((v as any).toJSON())
  }
  if (Array.isArray(v)) {
    return '[' + v.map(stableStringifyV2).join(',') + ']'
  }
  // Tier 367: skip `undefined`-valued keys — Prisma drops them when writing
  // the jsonb payload, so hashing them made the write and verify paths
  // disagree. `null` is kept (jsonb stores it). See audit-log.extension.ts for
  // the measurement.
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringifyV2(v[k]))
      .join(',') +
    '}'
  )
}

const stringifyFor = (algorithm: string) =>
  algorithm === AUDIT_HASH_V1 ? stableStringifyV1 : stableStringifyV2

function computeAuditHash(c: {
  action: string
  entityType: string | null
  entityId: string | null
  userId: string | null
  companyId: string | null
  oldData: any
  newData: any
  previousHash: string
  createdAt: Date
}, algorithm: string = AUDIT_HASH_ALGORITHM): string {
  const stableStringify = stringifyFor(algorithm)
  const payload = [
    c.action,
    c.entityType ?? '',
    c.entityId ?? '',
    c.userId ?? '',
    c.companyId ?? '',
    stableStringify(c.oldData),
    stableStringify(c.newData),
    c.previousHash,
    c.createdAt.toISOString(),
  ].join('|')
  return createHash('sha256').update(payload).digest('hex')
}

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
  // Tier 202 — when set, rows with
  // companyId=null are included in
  // addition to rows matching
  // `companyId`. Used by the
  // activity-log endpoint so
  // cross-company admin actions
  // (e.g. cron.run_manually) show
  // up in the Berater's feed.
  includeNullCompanyId?: boolean
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
   * Tier 202 — write an activity-log row.
   *
   * Used by admin controllers to record
   * operator actions (requeue,
   * resolve-all, mute-all, cron-run,
   * test-notification, etc) in the
   * same tamper-evident hash chain as
   * business events (Tier 196).
   *
   * The action name follows the
   * `<entity>.<verb>` convention, e.g.
   * `error.resolve_all`,
   * `webhook.requeue`,
   * `cron.run_manually`. The
   * `entityType` + `entityId` are set
   * for cross-entity queries (e.g.
   * "all requeue events for webhook
   * X"). `metadata` is a free-form
   * JSON blob with the per-action
   * context (e.g. count, ids, notes)
   * — stored in the existing `newData`
   * column (no schema migration
   * needed).
   *
   * Tier 208 — MED-006. `entityId` is
   * OPTIONAL by design. The rule:
   *   - Single-row actions (e.g.
   *     `webhook.requeue`,
   *     `notification.test`,
   *     `signing.regenerate`) set
   *     `entityId` to the affected
   *     row's id.
   *   - Bulk actions (e.g.
   *     `error.resolve_all`,
   *     `error.mute_all`) DO NOT set
   *     `entityId` because they affect
   *     an unknown number of rows.
   *     The scope lives in
   *     `metadata.count` + the matching
   *     /system/errors query (which
   *     returns the per-row outcome).
   *   - Cross-company admin actions
   *     (e.g. `cron.run_manually`) set
   *     `entityId` to the cron name
   *     (e.g. `"webhook-retry-worker"`)
   *     and `companyId: null`.
   *
   * The verifyChain walk in
   * `verifyChain` (below) treats
   * activity rows and per-write audit
   * rows uniformly — `entityId = null`
   * does NOT break the chain.
   *
   * Implementation: inlines the same
   * hash-chain write logic as
   * `audit-log.extension.ts`'s
   * private `writeAudit` (read previous
   * row, compute hash, write row). We
   * duplicate rather than re-export
   * because the extension's helper is
   * internal. Both paths use the same
   * `computeAuditHash` + `stableStringify`
   * shape — the per-write audit log
   * and the activity log share one
   * chain. The `verifyChain` walk
   * treats them uniformly.
   *
   * Failure mode: never throws. The
   * operator's primary action MUST NOT
   * fail because the audit log write
   * failed. Errors are logged to
   * console only.
   */
  async writeActivity(input: {
    companyId: string | null
    userId: string | null
    action: string
    entityType: string
    entityId?: string | null
    metadata?: Record<string, any>
    // Tier 368: the call sites being migrated onto this method (auth, assets,
    // company) wrote these columns directly. Without them here the migration
    // would silently drop the login audit trail's ipAddress/userAgent and the
    // storno/feature-flag before-images. `ipAddress`/`userAgent` are stored but
    // NOT hashed — same as the extension's writeAudit. `oldData` IS hashed.
    ipAddress?: string | null
    userAgent?: string | null
    oldData?: Record<string, any> | null
  }): Promise<void> {
    try {
      // Read the previous row's hash to chain this one to it. Tier 366: the
      // newest SIGNED row. Tier 367: ordered by `seq` and serialised by the
      // same per-company advisory lock the extension takes, so the activity log
      // and the per-write audit log — which share one chain — cannot pick the
      // same predecessor concurrently. See audit-log.extension.ts for the full
      // account of the two defects this closes.
      const lockKey = input.companyId || '__no_company__'
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}::text))`
          const prev = await tx.auditLog.findFirst({
            where: { companyId: input.companyId || null, hash: { not: null } },
            orderBy: { seq: 'desc' },
            select: { hash: true },
          })
          const previousHash = prev?.hash ?? ''
          // Round createdAt to the second boundary (Tier 194/196 pattern) so
          // the hash input matches what the verify path recomputes after PG
          // round-trips the value.
          const createdAtRounded = new Date(
            Math.floor(Date.now() / 1000) * 1000,
          )
          const hash = computeAuditHash({
            action: input.action,
            entityType: input.entityType,
            entityId: input.entityId ?? null,
            userId: input.userId,
            companyId: input.companyId,
            oldData: input.oldData ?? null,
            newData: input.metadata || null,
            previousHash,
            createdAt: createdAtRounded,
          })
          await tx.auditLog.create({
            data: {
              companyId: input.companyId,
              userId: input.userId,
              action: input.action,
              entityType: input.entityType,
              entityId: input.entityId || null,
              oldData: input.oldData ?? undefined,
              newData: input.metadata || undefined,
              ipAddress: input.ipAddress ?? null,
              userAgent: input.userAgent ?? null,
              createdAt: createdAtRounded,
              hash,
              previousHash,
              hashAlgorithm: AUDIT_HASH_ALGORITHM,
            },
          })
        },
        { timeout: 20000, maxWait: 20000 },
      )
    } catch (err) {
      // Don't fail the operator's
      // action because the audit
      // log write failed. Just log
      // to backend console — same
      // pattern as the private
      // writeAudit helper.
       
      console.error(
        '[audit/activity] failed to write activity row:',
        (err as Error).message,
      )
    }
  }

  /**
   * Tier 368 — resolve actor e-mails without a foreign key.
   *
   * AuditLog no longer has a relation to User (migration
   * 20260912000002_audit_log_drop_actor_fks): the FK was ON DELETE SET NULL, so
   * deleting a user silently rewrote `userId` on rows that were already signed,
   * and the chain broke with hash_mismatch through no tampering at all.
   *
   * `userId` is now a plain snapshot that may name a user who no longer exists.
   * This resolves the e-mails in ONE batched query per page (never N+1) and
   * shapes the result exactly like the old relation did, so every caller that
   * reads `r.user?.email` keeps working. A row whose user is gone keeps its
   * userId and gets a null e-mail — which is the history an auditor should see.
   */
  private async attachUserEmails<T extends { userId: string | null }>(
    rows: T[],
  ): Promise<(T & { user: { email: string } | null })[]> {
    const ids = [
      ...new Set(
        rows.map((r) => r.userId).filter((id): id is string => !!id),
      ),
    ]
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, email: true },
        })
      : []
    const byId = new Map(users.map((u) => [u.id, u.email]))
    return rows.map((r) => ({
      ...r,
      user:
        r.userId && byId.has(r.userId)
          ? { email: byId.get(r.userId) as string }
          : null,
    }))
  }

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
    // Tier 202 — for cross-company
    // activity events (companyId=null),
    // OR with the given companyId so
    // the operator sees their own
    // + the global admin actions.
    const companyFilter: Prisma.AuditLogWhereInput = f.includeNullCompanyId
      ? { OR: [{ companyId: f.companyId }, { companyId: null }] }
      : { companyId: f.companyId }
    const where: Prisma.AuditLogWhereInput = { ...companyFilter }
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
          // Tier 202 — include newData
          // so the activity page can
          // render the per-action
          // metadata blob (e.g.
          // {count: 5} for resolve_all,
          // {webhookId, eventType} for
          // webhook.requeue). oldData
          // is null for activity rows
          // (we use a "snapshot" not
          // a diff), so we don't
          // bother selecting it.
          newData: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ])
    return {
      // Tier 368: the "who" column used to come from a Prisma relation; the FK
      // is gone, so the e-mails are resolved in one batched lookup.
      rows: (await this.attachUserEmails(rows)).map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userId: r.userId,
        userEmail: r.user?.email ?? null,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt,
        // Tier 202 — include newData
        // so the activity page can
        // surface the per-action
        // metadata.
        newData: r.newData ?? null,
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
        // Tier 207 — include newData + oldData
        // in the SELECT. The text-search path
        // is taken whenever `?q=` is set, and
        // both the UI list view (for the metadata
        // badge per row) and the exportCsv
        // GoBD-grade path need the JSON payload
        // columns. Without these, the text-search
        // path silently degraded both surfaces
        // (the original list() Prisma path
        // includes them, so the bug was
        // invisible until a user actually
        // searched for something).
        `SELECT al.id, al.action, al."entityType", al."entityId",
                al."userId", al."ipAddress", al."createdAt",
                al."newData", al."oldData",
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
        newData: r.newData ?? null,
        oldData: r.oldData ?? null,
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
      },
    })
    if (!row) return null
    // Tier 368: resolve the actor e-mail without the (now removed) relation.
    const [rowWithUser] = await this.attachUserEmails([row])
    return {
      ...rowWithUser,
      userEmail: rowWithUser.user?.email ?? null,
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
  /**
   * Tier 204 — activity-log CSV export.
   * Same shape as `exportCsv()` but
   * hard-codes the action prefix to
   * the 4 activity namespaces
   * (`error.`, `webhook.`, `cron.`,
   * `notification.`) and includes
   * cross-company rows
   * (`companyId=null`) by default.
   * Operator pulls the last N days
   * of operator actions into Excel
   * for the Berater's monthly
   * compliance review.
   *
   * Columns are stable +
   * machine-readable (German
   * labels to match the existing
   * audit export):
   *   Zeitstempel, Aktion, Entitaet,
   *   Entity-ID, Benutzer, IP,
   *   Metadata
   *
   * The Berater's Excel workflow:
   *   1. open the file
   *   2. sort by `Benutzer` to see
   *      what each operator did
   *   3. filter by `Aktion` to
   *      drill into one action type
   *   4. pivot on `Entitaet` to see
   *      the impact of each action
   *
   * @param companyId the caller's
   *   company — used in the OR
   *   filter so cross-company
   *   admin rows (companyId=null)
   *   are included.
   * @param days 1..365 (default 90,
   *   capped at 365).
   * @param actionPrefix optional
   *   single-prefix filter (e.g.
   *   "error."). When omitted, all
   *   4 activity prefixes are
   *   included.
   * @param userId optional actor
   *   filter.
   */
  async exportActivityCsv(
    companyId: string,
    days = 90,
    actionPrefix?: string,
    userId?: string,
  ): Promise<string> {
    const daysClamped = Math.min(Math.max(days, 1), 365)
    const cutoff = new Date(
      Date.now() - daysClamped * 24 * 60 * 60 * 1000,
    )
    const prefixes = actionPrefix
      ? [actionPrefix]
      : ['error.', 'webhook.', 'cron.', 'notification.']
    // OR with companyId=null so
    // cross-company admin
    // actions (cron.run_manually
    // is admin-scoped) show up in
    // the Berater's feed.
    const where: any = {
      createdAt: { gte: cutoff },
      action: { startsWith: prefixes[0] },
      OR: [{ companyId }, { companyId: null }],
    }
    if (prefixes.length > 1) {
      // Multiple prefixes — use
      // `action: { in: [...] }` with
      // a startsWith filter. We
      // can't use Prisma's
      // `startsWith` with multiple
      // values, so we OR them in
      // raw. Simpler approach:
      // fetch each prefix and
      // concat. For 4 prefixes
      // and a 365-day cap, this
      // is at most 4 queries.
      const allRows: any[] = []
      for (const p of prefixes) {
        const rows = await this.prisma.auditLog.findMany({
          where: {
            createdAt: { gte: cutoff },
            action: { startsWith: p },
            OR: [{ companyId }, { companyId: null }],
            ...(userId ? { userId } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 10_000,
          select: {
            // Tier 204 — `id` MUST be
            // in the select for the
            // dedupe step below. The
            // multi-prefix branch
            // fetches each prefix in
            // its own query, then
            // concats — the dedupe
            // `seen: Set<string>` is
            // keyed on `r.id`. Without
            // `id` in the select, all
            // rows have undefined id
            // and the dedupe collapses
            // everything to 1 row.
            id: true,
            createdAt: true,
            action: true,
            entityType: true,
            entityId: true,
            userId: true,
            ipAddress: true,
            newData: true,
          },
        })
        // Tier 368: relation removed — resolve e-mails per prefix batch.
        allRows.push(...(await this.attachUserEmails(rows)))
      }
      // Dedupe (a row could in
      // theory match multiple
      // prefixes — won't happen
      // for the 4 activity
      // namespaces, but defensive).
      const seen = new Set<string>()
      const deduped = allRows.filter((r) => {
        if (seen.has(r.id)) return false
        seen.add(r.id)
        return true
      })
      // Sort merged by createdAt desc.
      deduped.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      )
      return this.buildActivityCsv(deduped)
    }
    // Single prefix path (one
    // query — simpler).
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...where,
        ...(userId ? { userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
      select: {
        // Tier 204 — `id` is in
        // the select even for the
        // single-prefix path for
        // consistency (the
        // buildActivityCsv doesn't
        // need it but the
        // future-proofing is cheap
        // and aligns the two
        // branches).
        id: true,
        createdAt: true,
        action: true,
        entityType: true,
        entityId: true,
        userId: true,
        ipAddress: true,
        newData: true,
      },
    })
    // Tier 368: relation removed — resolve e-mails in one batched lookup.
    return this.buildActivityCsv(await this.attachUserEmails(rows))
  }

  /**
   * Build the CSV body for the
   * activity-log export. Shared
   * between the single-prefix and
   * multi-prefix code paths above
   * so the column shape stays
   * consistent.
   */
  private buildActivityCsv(rows: any[]): string {
    const esc = (v: any): string => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      if (/[",\n\r;]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"'
      }
      return s
    }
    // Note: the German labels
    // match the existing audit
    // export. We use `;` as the
    // delimiter (Excel DE default
    // for CSV — the German locale
    // uses semicolons in CSV
    // files). Same pattern as
    // `exportCsv()`.
    const header = [
      'Zeitstempel',
      'Aktion',
      'Entitaet',
      'Entity-ID',
      'Benutzer',
      'IP',
      'Metadata',
    ]
    const lines: string[] = [header.map(esc).join(';')]
    for (const r of rows) {
      lines.push(
        [
          r.createdAt.toISOString(),
          r.action,
          r.entityType ?? '',
          r.entityId ?? '',
          r.user?.email ?? r.userId ?? '',
          r.ipAddress ?? '',
          r.newData ? JSON.stringify(r.newData) : '',
        ]
          .map(esc)
          .join(';'),
      )
    }
    if (rows.length === 10_000) {
      // Truncation marker — same
      // `#` prefix convention as
      // the webhook CSV (Tier 203).
      lines.push(
        '# truncated: hit 10,000-row cap. Narrow the days / actionPrefix / userId filter to export more.',
      )
    }
    return lines.join('\n') + '\n'
  }

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
      // listWithTextSearch now returns newData +
      // oldData (Tier 207 — the text-search SELECT
      // was missing these, which silently degraded
      // the GoBD-grade CSV export for any audit-log
      // search). userEmail comes back flat, so we
      // fold it into a user-shaped stub for the
      // CSV row builder below.
      rawRows = page.rows.map((r) => ({
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userId: r.userId,
        ipAddress: r.ipAddress,
        oldData: r.oldData ?? null,
        newData: r.newData ?? null,
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
        },
      })
      // Tier 368: relation removed — resolve e-mails in one batched lookup.
      // (The raw-SQL branch above already carries userEmail from its own
      // LEFT JOIN, which never needed the foreign key.)
      rawRows = await this.attachUserEmails(rawRows)
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

  // ========== Tier 196 — hash-chain verify ==========

  /**
   * Walk every audit row in the company's chain
   * (ordered by createdAt then id) and check:
   *   1. each row's stored hash matches a re-derivation
   *      of the same canonical input
   *   2. each row's previousHash matches the previous
   *      row's stored hash
   *
   * Returns the first broken link (or ok=true if
   * the entire chain is intact). Algorithm: we
   * sort by createdAt + id in JS rather than
   * paginate in SQL because (a) the typical
   * chain length is a few thousand rows, easy
   * to hold in memory, and (b) we want the
   * exact same ordering logic as the write path
   * in audit-log.extension.ts so the two
   * directions agree.
   */
  async verifyChain(companyId: string): Promise<{
    ok: boolean
    totalRows: number
    verifiedRows: number
    brokenAt: {
      id: string
      createdAt: string
      reason: 'hash_mismatch' | 'previous_hash_mismatch' | 'missing_hash'
      expectedHash: string | null
      actualHash: string | null
    } | null
    algorithm: string
    verifiedAt: string
  }> {
    // Tier 367: walk by `seq`. It is the only order the writer and this walk
    // can agree on — createdAt is rounded to whole seconds and ids are random
    // UUIDs, so (createdAt, id) put same-second rows in an order the writer
    // never used.
    const rows = await this.prisma.auditLog.findMany({
      where: { companyId },
      orderBy: { seq: 'asc' },
    })
    let expectedPreviousHash = ''
    for (const r of rows) {
      if (!r.hash) {
        // Pre-Tier 196 rows have null hash. We
        // accept them as "signed=false" entries
        // that don't break the chain for post-
        // Tier 196 rows. The chain is broken
        // here only if a post-Tier 196 row
        // (which we detect by the algorithm
        // string) is missing its hash.
        if (r.hashAlgorithm) {
          return {
            ok: false,
            totalRows: rows.length,
            verifiedRows: 0,
            brokenAt: {
              id: r.id,
              createdAt: r.createdAt.toISOString(),
              reason: 'missing_hash',
              expectedHash: null,
              actualHash: null,
            },
            algorithm: r.hashAlgorithm,
            verifiedAt: new Date().toISOString(),
          }
        }
        continue
      }
      const recomputed = computeAuditHash({
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        userId: r.userId,
        companyId: r.companyId,
        oldData: r.oldData,
        newData: r.newData,
        previousHash: r.previousHash ?? '',
        createdAt: r.createdAt,
      }, r.hashAlgorithm || AUDIT_HASH_V1)
      if (recomputed !== r.hash) {
        return {
          ok: false,
          totalRows: rows.length,
          verifiedRows: 0,
          brokenAt: {
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            reason: 'hash_mismatch',
            expectedHash: r.hash,
            actualHash: recomputed,
          },
          algorithm: r.hashAlgorithm || 'UNKNOWN',
          verifiedAt: new Date().toISOString(),
        }
      }
      if ((r.previousHash ?? '') !== expectedPreviousHash) {
        return {
          ok: false,
          totalRows: rows.length,
          verifiedRows: 0,
          brokenAt: {
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            reason: 'previous_hash_mismatch',
            expectedHash: expectedPreviousHash,
            actualHash: r.previousHash ?? '',
          },
          algorithm: r.hashAlgorithm || 'UNKNOWN',
          verifiedAt: new Date().toISOString(),
        }
      }
      expectedPreviousHash = r.hash
    }
    // Tier 366: a chain can hold V1 rows (written before Tier 366) and V2 rows;
    // report the algorithm of the newest signed row rather than a constant.
    const newestSigned = [...rows].reverse().find((r) => r.hash)
    return {
      ok: true,
      totalRows: rows.length,
      verifiedRows: rows.length,
      brokenAt: null,
      algorithm: newestSigned?.hashAlgorithm || AUDIT_HASH_ALGORITHM,
      verifiedAt: new Date().toISOString(),
    }
  }

  /**
   * Verify a single audit row. Loads the row and
   * calls the same hash function the write path
   * used. Always returns 200; the caller inspects
   * the `verified` boolean to render a badge.
   */
  async verifyOne(
    companyId: string,
    id: string,
  ): Promise<{
    id: string
    signed: boolean
    verified: boolean
    algorithm: string | null
    storedHash: string | null
    recomputedHash: string
    verifiedAt: string
  }> {
    const r = await this.prisma.auditLog.findFirst({
      where: { id, companyId },
    })
    if (!r) {
      throw new BadRequestException('Audit-Eintrag nicht gefunden')
    }
    const recomputed = computeAuditHash({
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      userId: r.userId,
      companyId: r.companyId,
      oldData: r.oldData,
      newData: r.newData,
      previousHash: r.previousHash ?? '',
      createdAt: r.createdAt,
    }, r.hashAlgorithm || AUDIT_HASH_V1)
    const signed = !!r.hash
    const verified = signed && recomputed === r.hash
    return {
      id: r.id,
      signed,
      verified,
      algorithm: r.hashAlgorithm,
      storedHash: r.hash,
      recomputedHash: recomputed,
      verifiedAt: new Date().toISOString(),
    }
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
