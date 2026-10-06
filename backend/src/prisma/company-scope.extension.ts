import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

/**
 * Tier 551 — `where: { companyId: undefined }` is not "no company", it is
 * "every company".
 *
 * Prisma drops an undefined filter. A route that passes `?companyId=` straight
 * into a where clause therefore answered a request WITHOUT the parameter with
 * every company's rows (measured: GET /invoices, /webhooks, /reports/sales,
 * /reports/customers, /reminders/overdue). The auth guard only compares a
 * companyId that is there.
 *
 * So the filter is refused here, for every model and operation: a where
 * clause that names `companyId` must give it a value. Code that really means
 * all companies (a scheduler) leaves the key out.
 */
function hasUndefinedCompany(where: unknown, depth = 0): boolean {
  if (!where || typeof where !== 'object' || depth > 6) return false
  if (Array.isArray(where)) return where.some((w) => hasUndefinedCompany(w, depth + 1))
  if (where instanceof Date || Buffer.isBuffer(where)) return false
  const o = where as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(o, 'companyId') && o.companyId === undefined) return true
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v && typeof v === 'object' && hasUndefinedCompany(v, depth + 1)) return true
  }
  return false
}

export const companyScope = Prisma.defineExtension({
  name: 'company-scope',
  query: {
    $allModels: {
      $allOperations({ args, query }) {
        if (hasUndefinedCompany((args as { where?: unknown } | undefined)?.where)) {
          throw new BadRequestException('companyId ist erforderlich')
        }
        return query(args)
      },
    },
  },
})
