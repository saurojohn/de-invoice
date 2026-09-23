// Tier 13: Prisma client extension that
// automatically writes an AuditLog row
// for every update, updateMany, delete,
// and deleteMany. This is the GoBD
// "Wer hat wann was geändert?" answer:
//
// The request context (who / which company / IP) comes from
// ./request-context — one per request since Tier 384.

import { Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'async_hooks'
import { getRequestContext } from './request-context'
import { createHash } from 'crypto'

// Tier 196 — hash chain algorithm identifier.
// Same string convention as the CashBook Tier 194
// signature so the verify toolchain is uniform
// across both subsystems.
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

// Exported (Tier 367) so a diagnostic can canonicalise with the REAL function
// instead of a copy. Tier 366 lost a cycle to exactly that: a hand-reasoned
// duplicate of this logic agreed with itself and disagreed with production.
export const stableStringifyV2 = (v: any): string => {
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
  // Tier 367: skip keys whose value is `undefined`. Prisma drops them when it
  // writes the payload into the jsonb column, so the verify path re-reads an
  // object that never had the key — while the write path hashed it as
  // `"key":` (V2 maps both null and undefined to ''). Measured: a
  // `recurringinvoice.created` result carries `invoiceNumber: undefined`, and
  // that row was the first in the chain to report hash_mismatch (write 933
  // chars, read 916, diverging at offset 429).
  //
  // `null` is deliberately NOT skipped — jsonb stores nulls faithfully, so
  // both sides see them. And this cannot break a row that previously verified:
  // it only changes payloads that carried an undefined-valued key, which by
  // construction never matched.
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


/**
 * Tier 196 — compute the integrity hash for a
 * single audit row. The hash is over a pipe-
 * separated canonical string of the row's content
 * plus the previous row's hash. Same pattern as
 * the Tier 194 CashBook signature, extended with
 * the previousHash pointer.
 *
 * Field order is significant and must stay
 * stable — the verify endpoint re-derives with
 * the same order and asserts equality. If you
 * add a field, bump the algorithm string
 * (SHA-256-V2) and write a migration that
 * re-hashes every existing row.
 */
export function computeAuditHash(c: {
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

// These are the models we audit.
// The set is intentionally narrow —
// user/auth system errors have their
// own logging path; ephemeral session
// data doesn't need a paper trail.
const AUDITED_MODELS = new Set<string>([
  'Customer',
  'Invoice',
  'InvoiceItem',
  'Product',
  'Expense',
  'Voucher',
  'RecurringInvoice',
  'Reminder',
  'BankStatement',
  'BankTransaction',
  'Attachment',
  'Supplier',
  'CashBookEntry',
  'Account',
  'JournalEntry',
  // Tier 9/10: VatReverify, FinTsTransfer,
  // VatValidationResult are business data
  // that the Finanzamt may want to see.
  'VatValidationResult',
  'FinTsTransfer',
  // Tier 208 — MED-005. Per-row audit
  // on ErrorEvent.resolve / mute.
  // Pre-fix only the activity log
  // recorded the bulk operator
  // action, but a Steuerpruefer
  // asking "which operator resolved
  // error X?" had no per-row trail
  // for individually-resolved
  // errors. Now the audit log
  // captures the per-row resolve /
  // mute. The activity log still
  // records bulk actions
  // (error.resolve_all,
  // error.mute_all) with the
  // metadata.count. Both layers
  // together: per-row for
  // individual actions, summary
  // for bulk.
  'ErrorEvent',
  // Tier 407 — records that carry money or settle a debt, and had no trail at
  // all. Measured: a 119 € cash payment recorded and then deleted left three
  // `invoice.updated` rows and nothing naming the payment, its amount or who
  // removed it. None of these services wrote an explicit audit row either.
  'Payment',
  'Mahnung',
  'Mahnungspause',
  'InstallmentPlan',
  'Installment',
  // Tier 430: a payment the customer reported, and who booked or dismissed it.
  'PaymentNotice',
  'CustomerCreditTransaction',
  'CashBookDailyClose',
  'UStvaFiling',
  'VoucherLine',
  'BankReconciliation',
  'SepaBatch',
  'SepaDirectDebitMandate',
  'SepaDirectDebitBatch',
  'SepaDirectDebitCollection',
  'VatRate',
  // …and who may do what: the company's master data (tax numbers, bank
  // details) and a member's role in it. See the PEM redaction in sanitize().
  'Company',
  'UserCompany',
])

// Strip fields that shouldn't go in
// oldData / newData:
//   - bcrypt hashes (security: even on
//     delete, the hash is recoverable)
//   - large JSON blobs (audit rows
//     shouldn't blow up to 10MB because
//     someone updated a Profile field)
//   - timestamps (already in createdAt /
//     updatedAt of the AuditLog row itself)
const SENSITIVE_FIELDS = new Set<string>([
  'passwordHash',
  'passwordResetToken',
  'twoFactorSecret',
  // Tier 407: named secrets that could appear once more models are audited.
  'recoveryCodes',
  'keyPem',
  'privateKey',
  'pinEncrypted',
  'pin',
  'password',
  'secret',
])

const MAX_JSON_BYTES = 8 * 1024 // 8KB

// Tier 407: any string that is a PEM private key, wherever it sits.
//
// Company joined the audited models in Tier 407, and before Tier 208 a
// company's signing key lived in Company.settings.signing.key. A database from
// that era would copy the private key into AuditLog — an append-only,
// hash-chained table that can never be cleaned — on the first company update.
// Matching the PEM armour rather than a field name also covers keys under
// names nobody thought of.
const PRIVATE_KEY_PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

const isPlainObject = (v: any): boolean => {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// Returns `value` itself when nothing needs redacting, otherwise a copy of just
// the levels that changed. Never mutates: `sanitize(result)` used to overwrite
// fields on the very object the query returned to the service. Decimal and
// Date instances are left alone — the hash canonicalisation (Tier 366) relies
// on seeing them as they are.
const redactDeep = (value: any, depth: number): any => {
  if (typeof value === 'string') {
    return PRIVATE_KEY_PEM.test(value) ? '[REDACTED]' : value
  }
  if (depth > 12) return value
  if (Array.isArray(value)) {
    let out: any[] | null = null
    for (let i = 0; i < value.length; i++) {
      const r = redactDeep(value[i], depth + 1)
      if (r !== value[i]) {
        const copy: any[] = out ?? value.slice()
        copy[i] = r
        out = copy
      }
    }
    return out || value
  }
  if (isPlainObject(value)) {
    let out: Record<string, any> | null = null
    for (const k of Object.keys(value)) {
      const r = SENSITIVE_FIELDS.has(k) ? '[REDACTED]' : redactDeep(value[k], depth + 1)
      if (r !== value[k]) {
        const copy: Record<string, any> = out ?? { ...value }
        copy[k] = r
        out = copy
      }
    }
    return out || value
  }
  return value
}

const sanitize = (input: any): any => {
  if (input == null) return null
  if (typeof input !== 'object') return input
  // Always a fresh top level, so callers that add fields (the Invoice branch in
  // the create hook) never touch the query's result object.
  const redacted = redactDeep(input, 0)
  const data = redacted === input ? { ...input } : redacted
  // Truncate if too large
  const json = JSON.stringify(data)
  if (json.length > MAX_JSON_BYTES) {
    return { _truncated: true, _size: json.length, _preview: json.slice(0, 1000) }
  }
  return data
}

// action string per operation kind
const actionOf = (op: 'create' | 'update' | 'delete' | 'updateMany' | 'deleteMany', model: string): string => {
  if (op === 'create') return `${model.toLowerCase()}.created`
  if (op === 'update' || op === 'updateMany') return `${model.toLowerCase()}.updated`
  return `${model.toLowerCase()}.deleted`
}

// IMPORTANT — Prisma 5 extension architecture gotcha:
// In `query.$allModels.operations` callbacks, `this`
// is NOT the extended client (which would give
// `this.auditLog.create` for writing the audit row).
// Instead, `this` is the model itself, exposed as
// an Array of available operation functions. So we
// can't reach the rest of the client from inside
// the callback.
//
// The fix: capture the client at extension creation
// time, before the extension is applied. We use
// the captured reference inside the callback via
// closure. This works because `client` is the
// EXTENDED client (after $extends), so calling
// `client.auditLog.create(...)` from inside the
// extension re-enters the same extension's query
// pipeline for the create operation — which is a
// no-op (we don't wrap create) and writes the
// audit row.
//
// We use a small lookup object so the factory
// can also accept a pre-construction `client`
// reference. The recommended pattern from the
// Prisma docs uses `Prisma.getExtensionContext`
// — but in $allModels, `this` doesn't have it.
// Apply the extension to a PrismaClient
// instance. The `client` reference is captured
// in a closure so the extension's query hooks
// can call back into it (to write the audit
// row). We use the OBJECT form of
// defineExtension (not the callback form) because
// the callback form strips model accessors
// from the returned client (Prisma 5 quirk).
//
// The trade-off: we need to construct the
// extension AFTER the Prisma client exists,
// because the extension closes over the client
// reference. So the factory has to be called
// from inside `withAuditLog`, not at module
// load time. This is what `withAuditLog`
// does — see below.
let _auditLogClient: any = null

export function createAuditLogExtension() {
  // Object form — this PRESERVES the model
  // accessors on the extended client (verified
  // by direct test). The trick: we don't need
  // to capture `client` in the factory closure
  // because we use a module-global (`_auditLogClient`)
  // that `withAuditLog` sets before applying the
  // extension. This works because the extension
  // is applied synchronously, before any request
  // can reach the model.
  //
  // The `as any` is needed because TypeScript
  // can't narrow the type through the
  // defineExtension's call signature (which
  // requires the result to have `$extends`,
  // which only the base client has).
  return Prisma.defineExtension({
    name: 'auditLog',
    query: {
      $allModels: {
        async create({ model, _operation, args, query }: any) {
          if (!AUDITED_MODELS.has(model)) return query(args)
          const result = await query(args)
          // Tier 304: ensure the newData blob
          // includes the most-audited fields
          // (invoiceNumber for Invoice, etc).
          // The default `sanitize(result)` would
          // include every column — but a Tier 174
          // refactor of invoice.service.ts no
          // longer puts invoiceNumber on the
          // returned object (it's resolved by the
          // DB default and read back by a separate
          // SELECT). The audit trail then loses
          // the human-readable ID. We explicitly
          // surface invoiceNumber for the
          // Invoice + RecurringInvoice models.
          const data = sanitize(result)
          if (model === 'Invoice' || model === 'RecurringInvoice') {
            // Tier 367: assign only what the model actually has. RecurringInvoice
            // has no invoiceNumber column, so `result.invoiceNumber` is undefined
            // and this line CREATED an own key holding undefined. The write path
            // hashed it as `"invoiceNumber":`; Prisma drops undefined keys when
            // writing jsonb, so the verify path re-read a payload without it and
            // every recurringinvoice.created row failed as hash_mismatch. It was
            // the first such row in a seeded chain (write 933 chars, read 916).
            // stableStringifyV2 now skips undefined keys as well — this stops
            // fabricating one at the source. Storage is unchanged either way.
            if ((result as any).invoiceNumber !== undefined) {
              data.invoiceNumber = (result as any).invoiceNumber
            }
            if ((result as any).customerId !== undefined) {
              data.customerId = (result as any).customerId
            }
          }
          await writeAudit(_auditLogClient, {
            action: actionOf('create', model),
            entityType: model,
            entityId: extractId(args, result),
            oldData: null,
            newData: data,
          })
          return result
        },
        async update({ model, _operation, args, query }: any) {
          if (!AUDITED_MODELS.has(model)) return query(args)
          const before = await getPreImage(_auditLogClient, model, args)
          const result = await query(args)
          await writeAudit(_auditLogClient, {
            action: actionOf('update', model),
            entityType: model,
            entityId: extractId(args, result),
            oldData: sanitize(before),
            newData: sanitize(result),
          })
          return result
        },
        async updateMany({ model, _operation, args, query }: any) {
          if (!AUDITED_MODELS.has(model)) return query(args)
          const affected = await findAffected(_auditLogClient, model, args.where)
          const result = await query(args)
          await writeBulkAudit(model, 'updateMany', args, result, affected)
          return result
        },
        // Tier 407: upsert had no hook, so every write made with it skipped the
        // trail — measured: changing a member's role (users.service changeRole
        // upserts the UserCompany row) left no audit row at all.
        async upsert({ model, _operation, args, query }: any) {
          if (!AUDITED_MODELS.has(model)) return query(args)
          const before = await getPreImage(_auditLogClient, model, args)
          const result = await query(args)
          await writeAudit(_auditLogClient, {
            action: actionOf(before ? 'update' : 'create', model),
            entityType: model,
            entityId: extractId(args, result),
            oldData: sanitize(before),
            newData: sanitize(result),
          })
          return result
        },
        // Tier 407: nothing calls this on an audited model today; it is here so
        // the first caller does not silently open the same gap.
        async createMany({ model, _operation, args, query }: any) {
          if (!AUDITED_MODELS.has(model)) return query(args)
          const result = await query(args)
          await writeAudit(_auditLogClient, {
            action: `${model.toLowerCase()}.created`,
            entityType: model,
            entityId: 'bulk:' + String(Array.isArray(args?.data) ? args.data.length : 1),
            oldData: null,
            newData: { count: result?.count ?? null },
          })
          return result
        },
        async delete({ model, _operation, args, query }: any) {
          if (!AUDITED_MODELS.has(model)) return query(args)
          const before = await getPreImage(_auditLogClient, model, args)
          const result = await query(args)
          await writeAudit(_auditLogClient, {
            action: actionOf('delete', model),
            entityType: model,
            entityId: extractId(args, result) || (before && (before as any).id) || null,
            oldData: sanitize(before),
            newData: null,
          })
          return result
        },
        async deleteMany({ model, _operation, args, query }: any) {
          if (!AUDITED_MODELS.has(model)) return query(args)
          const affected = await findAffected(_auditLogClient, model, args.where)
          const result = await query(args)
          await writeBulkAudit(model, 'deleteMany', args, result, affected)
          return result
        },
      },
    },
  }) as any
}

// Apply the extension to a PrismaClient
// instance. Idempotent — calling twice
// doesn't double-apply because
// $extends returns a new client and we
// don't keep a reference to the old one.
export function withAuditLog(client: any): any {
  _auditLogClient = client
  return client.$extends(createAuditLogExtension())
}

// Look up the row BEFORE the mutation so
// we can capture oldData. Skip silently if
// the row is missing (race condition: the
// row was deleted between the request
// reaching the service and the extension
// running).
/**
 * Tier 408 — a bulk write is recorded per record, not as a count.
 *
 * updateMany / deleteMany used to leave one row: `bulk:<where>` and
 * `{ count }`. Measured on a customer merge: both invoices moved to the other
 * customer, each invoice's own trail still read only `invoice.created`, and the
 * one bulk row said "2 invoices of customer A were updated" — not which ones,
 * and not to what. The same shape covered a SEPA batch marking invoices paid,
 * the AfA storno deleting booked expenses, and an invoice's items being
 * removed with it. "Wer hat wann was geändert" had no answer for exactly the
 * operations that change many booked records at once.
 *
 * Now each affected record gets its own row under its own id, with its
 * before-image, and for an update its after-image. The after-image is read
 * lazily, when the row is written: inside a transaction that is after commit
 * (Tier 406's buffer), so it shows the committed state rather than the old
 * values an outside connection would still see mid-transaction.
 *
 * ErrorEvent keeps the summary row: its bulk operations are retention purges
 * and "resolve all" over operational data, recorded per row elsewhere
 * (Tier 208). A bulk that touches more than BULK_DETAIL_CAP records is
 * detailed up to the cap and summarised beyond it, so a runaway statement
 * cannot stall the request on the audit writer.
 */
const BULK_DETAIL_CAP = 5000
const BULK_SUMMARY_ONLY = new Set<string>(['ErrorEvent'])

async function findAffected(client: any, model: string, where: any): Promise<any[] | null> {
  if (BULK_SUMMARY_ONLY.has(model)) return null
  try {
    const rows = await client[lowerFirst(model)].findMany({
      where: where ?? {},
      take: BULK_DETAIL_CAP + 1,
    })
    // Per-record rows need a per-record id; composite-key models keep the summary.
    if (rows.length > 0 && !('id' in rows[0])) return null
    return rows
  } catch {
    return null
  }
}

async function writeBulkAudit(
  model: string,
  op: 'updateMany' | 'deleteMany',
  args: any,
  result: any,
  affected: any[] | null,
) {
  const count = Number(result?.count ?? 0)
  // Nothing matched, nothing changed: no row. A merge used to leave six
  // `{ count: 0 }` rows for relations the customer did not have.
  if (count === 0) return
  const summary = (extra: Record<string, unknown> = {}) =>
    writeAudit(_auditLogClient, {
      action: actionOf(op, model),
      entityType: model,
      entityId: 'bulk:' + JSON.stringify(args.where).slice(0, 200),
      oldData: null,
      newData: { count, ...extra },
    })
  if (!affected) {
    await summary()
    return
  }
  const detailed = affected.slice(0, BULK_DETAIL_CAP)
  let afterById: Promise<Map<string, any>> | null = null
  const after = () => {
    if (!afterById) {
      afterById = _auditLogClient[lowerFirst(model)]
        .findMany({ where: { id: { in: detailed.map((r) => r.id) } } })
        .then((rows: any[]) => new Map(rows.map((r) => [r.id, r])))
        .catch(() => new Map())
    }
    return afterById as Promise<Map<string, any>>
  }
  for (const row of detailed) {
    await writeAudit(_auditLogClient, {
      action: actionOf(op === 'updateMany' ? 'update' : 'delete', model),
      entityType: model,
      entityId: row.id,
      oldData: sanitize(row),
      newData:
        op === 'updateMany'
          ? async () => sanitize((await after()).get(row.id) ?? null)
          : null,
    })
  }
  if (affected.length > BULK_DETAIL_CAP) {
    await summary({ detailed: BULK_DETAIL_CAP, note: 'bulk larger than the per-record cap' })
  }
}

async function getPreImage(
  client: any,
  model: string,
  args: any,
): Promise<any> {
  try {
    if (args.where && args.where.id) {
      return await client[lowerFirst(model)].findUnique({ where: { id: args.where.id } })
    }
    // Tier 407: update/delete always take a unique input, and some audited
    // models have a composite key instead of an id (UserCompany is
    // userId + companyId). Without this their role changes had no before-image.
    if (args.where && typeof args.where === 'object') {
      return await client[lowerFirst(model)].findUnique({ where: args.where })
    }
    return null
  } catch {
    return null
  }
}

const lowerFirst = (s: string) => s[0].toLowerCase() + s.slice(1)

const extractId = (args: any, result: any): string | null => {
  if (result && typeof result === 'object' && 'id' in result) return result.id
  if (args && args.where && args.where.id) return args.where.id
  // Tier 407: a composite key (e.g. where: { userId_companyId: { userId,
  // companyId } }) becomes "userId:companyId", so the row is still findable.
  const where = args && args.where
  if (where && typeof where === 'object') {
    for (const v of Object.values(where)) {
      if (isPlainObject(v)) {
        const parts = Object.values(v as Record<string, unknown>)
        if (parts.length > 1 && parts.every((x) => typeof x === 'string')) {
          return (parts as string[]).join(':')
        }
      }
    }
  }
  if (result && typeof result === 'object' && typeof result.userId === 'string' && typeof result.companyId === 'string') {
    return `${result.userId}:${result.companyId}`
  }
  return null
}

type AuditEntry = {
  action: string
  entityType: string
  entityId: string | null
  oldData: any
  newData: any
}
type AuditCtx = {
  userId: string | null
  companyId: string | null
  ipAddress: string | null
  userAgent: string | null
}

/**
 * Tier 406 — audit rows for writes made inside an interactive transaction.
 *
 * Until now there were none. PrismaService copies the extended client's model
 * accessors onto itself but not `$transaction`, so `this.prisma.$transaction(
 * async (tx) => …)` ran on PrismaService's own, unextended client and every
 * write through `tx` skipped this extension entirely. Measured: a plain
 * invoice create left one AuditLog row, a credit note (created in such a
 * transaction) left none, and deleting a paid invoice removed the invoice and
 * its payment with no row at all. Eleven call sites were affected — credit
 * notes, recurring invoices, customer credit, customer merges, instalment
 * plans, portal payments, invitation acceptance and invoice deletion.
 *
 * Routing those transactions through the extended client is not enough on its
 * own: this module writes its rows on a separate connection, so a write that is
 * later rolled back would still leave a row saying it happened (measured: row
 * gone, audit row present). So inside a transaction the rows are held here and
 * written only once it has committed; a rollback discards them.
 */
const pendingAudit = new AsyncLocalStorage<Array<{ entry: AuditEntry; ctx: AuditCtx }>>()

export async function runWithBufferedAudit<T>(run: () => Promise<T>): Promise<T> {
  // Nested transaction: the outermost one decides when the rows are written.
  if (pendingAudit.getStore()) return run()
  const buffer: Array<{ entry: AuditEntry; ctx: AuditCtx }> = []
  // A rollback rejects here, before anything below runs — the buffer is dropped.
  const result = await pendingAudit.run(buffer, run)
  for (const { entry, ctx } of buffer) {
    await writeAuditNow(_auditLogClient, entry, ctx)
  }
  return result
}

async function writeAudit(client: any, entry: AuditEntry) {
  // The request context is captured now, not at flush time, so a buffered row
  // is attributed to whoever made the change.
  // A copy: the request context is one mutable object shared by the whole
  // request (the auth guard fills it in), and the fallback below must not leak
  // one row's company into the next write.
  const ctx: AuditCtx = {
    userId: null,
    companyId: null,
    ipAddress: null,
    userAgent: null,
    ...(getRequestContext() || {}),
  }
  // Tier 407: public routes (registration, invitation acceptance, the payment
  // portal) and crons have no company in the request context, so their rows
  // went onto the company-less chain — measured: every usercompany.created row
  // had companyId NULL and was invisible in the company's own trail. The row
  // being written knows its company; use that when the request does not.
  if (!ctx.companyId) {
    const own = entry.newData?.companyId ?? entry.oldData?.companyId
    if (typeof own === 'string' && own) {
      ctx.companyId = own
    }
  }
  const buffer = pendingAudit.getStore()
  if (buffer) {
    buffer.push({ entry, ctx })
    return
  }
  await writeAuditNow(client, entry, ctx)
}

async function writeAuditNow(client: any, rawEntry: AuditEntry, ctx: AuditCtx) {
  try {
    // Tier 408: a bulk update's after-image is resolved here, i.e. after the
    // change is committed (see writeBulkAudit).
    const entry: AuditEntry =
      typeof rawEntry.newData === 'function'
        ? { ...rawEntry, newData: await rawEntry.newData() }
        : rawEntry
    // Tier 196 — chain this row to the previous one. The chain is per-company;
    // on a fresh DB the first row's previousHash is ''.
    //
    // Tier 366: chain to the newest SIGNED row. Several services write audit
    // rows with no hash (auth, assets, company) and ci-seed.sh inserts some
    // directly; taking the newest row regardless left previousHash='' whenever
    // one of those landed in between, while verifyChain carries the last signed
    // hash forward — every such row reported previous_hash_mismatch.
    //
    // Tier 367: read-previous → hash → insert is one serialised critical
    // section per company, ordered by `seq`. Two defects lived in the gap this
    // closes, and the old comment here dismissed both as harmless:
    //
    //   - ORDER. The writer took max(createdAt, id) while verifyChain walked
    //     ascending (createdAt, id). createdAt is rounded to whole seconds and
    //     the id is a random UUID, so within one second the two disagreed about
    //     which row came last. A fresh seeded database had 15 rows in a single
    //     second and reported previous_hash_mismatch.
    //   - CONCURRENCY. Nothing serialised the read, so parallel writers all
    //     read the same predecessor and all chained to it — measured: twelve
    //     rows sharing one previousHash, and a mid-chain row with none.
    //
    // `seq` (monotonic, DB-assigned) is now the only order either side uses, and
    // pg_advisory_xact_lock gives one writer per company at a time. The lock is
    // transaction-scoped, so it is released on commit AND on rollback. The audit
    // insert already ran on its own connection whenever the caller was inside an
    // interactive transaction, so this adds no connection to the pool.
    const lockKey = ctx.companyId || '__no_company__'
    await client.$transaction(
      async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}::text))`
        const prev = await tx.auditLog.findFirst({
          where: { companyId: ctx.companyId || null, hash: { not: null } },
          orderBy: { seq: 'desc' },
          select: { hash: true },
        })
        const previousHash = prev?.hash ?? ''
        // The id is not hashed: it is server-generated and carries no
        // user-meaningful content. The tuple is (action, entityType, entityId,
        // userId, companyId, oldData, newData, previousHash, createdAt), with
        // createdAt rounded to the second (Tier 194/196 pattern) so the hash
        // input matches what the verify path recomputes after the PG round-trip.
        // Ordering no longer depends on that rounded value — `seq` does.
        const createdAtRounded = new Date(
          Math.floor(Date.now() / 1000) * 1000,
        )
        const hash = computeAuditHash({
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          userId: ctx.userId,
          companyId: ctx.companyId,
          oldData: entry.oldData,
          newData: entry.newData,
          previousHash,
          createdAt: createdAtRounded,
        })
        await tx.auditLog.create({
          data: {
            companyId: ctx.companyId || null,
            userId: ctx.userId || null,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId,
            oldData: entry.oldData || undefined,
            newData: entry.newData || undefined,
            ipAddress: ctx.ipAddress || null,
            userAgent: ctx.userAgent || null,
            createdAt: createdAtRounded,
            hash,
            previousHash,
            hashAlgorithm: AUDIT_HASH_ALGORITHM,
          },
        })
      },
      // Writers queue on the advisory lock; the default 5s ceiling is tight for
      // a burst. Each critical section is one SELECT plus one INSERT.
      { timeout: 20000, maxWait: 20000 },
    )
  } catch (err) {
    // Don't fail the user-facing request
    // if the audit log fails. Just log to
    // the backend console.
     
    console.error('[auditLog] failed to write audit row:', (err as Error).message)
  }
}

// (withAuditLog is defined above — duplicated line removed.)
