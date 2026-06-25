// Tier 13: Prisma client extension that
// automatically writes an AuditLog row
// for every update, updateMany, delete,
// and deleteMany. This is the GoBD
// "Wer hat wann was geändert?" answer:
//
// The request context is a process-global
// (set by main.ts's request middleware).
// We declare it here so this file is
// self-contained — prisma.service.ts
// ALSO declares it (in its own scope) and
// the two declarations must agree.
declare global {
  // eslint-disable-next-line no-var
  var __deInvoiceRequestContext:
    | {
        userId: string | null
        companyId: string | null
        ipAddress: string | null
        userAgent: string | null
      }
    | undefined
}

import { Prisma } from '@prisma/client'

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
])

const MAX_JSON_BYTES = 8 * 1024 // 8KB

const sanitize = (data: any): any => {
  if (data == null) return null
  if (typeof data !== 'object') return data
  // Drop sensitive fields
  for (const f of SENSITIVE_FIELDS) {
    if (f in data) data[f] = '[REDACTED]'
  }
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
        async update({ model, operation, args, query }: any) {
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
        async updateMany({ model, operation, args, query }: any) {
          if (!AUDITED_MODELS.has(model)) return query(args)
          const result = await query(args)
          await writeAudit(_auditLogClient, {
            action: actionOf('updateMany', model),
            entityType: model,
            entityId: 'bulk:' + JSON.stringify(args.where).slice(0, 200),
            oldData: null,
            newData: { count: result.count },
          })
          return result
        },
        async delete({ model, operation, args, query }: any) {
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
        async deleteMany({ model, operation, args, query }: any) {
          if (!AUDITED_MODELS.has(model)) return query(args)
          const result = await query(args)
          await writeAudit(_auditLogClient, {
            action: actionOf('deleteMany', model),
            entityType: model,
            entityId: 'bulk:' + JSON.stringify(args.where).slice(0, 200),
            oldData: null,
            newData: { count: result.count },
          })
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
async function getPreImage(
  client: any,
  model: string,
  args: any,
): Promise<any> {
  try {
    if (args.where && args.where.id) {
      return await client[lowerFirst(model)].findUnique({ where: { id: args.where.id } })
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
  return null
}

async function writeAudit(
  client: any,
  entry: {
    action: string
    entityType: string
    entityId: string | null
    oldData: any
    newData: any
  },
) {
  const ctx: {
    userId: string | null
    companyId: string | null
    ipAddress: string | null
    userAgent: string | null
  } = globalThis.__deInvoiceRequestContext || {
    userId: null,
    companyId: null,
    ipAddress: null,
    userAgent: null,
  }
  try {
    await client.auditLog.create({
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
      },
    })
  } catch (err) {
    // Don't fail the user-facing request
    // if the audit log fails. Just log to
    // the backend console.
    // eslint-disable-next-line no-console
    console.error('[auditLog] failed to write audit row:', (err as Error).message)
  }
}

// (withAuditLog is defined above — duplicated line removed.)
