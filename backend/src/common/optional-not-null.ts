import { ValidateIf } from 'class-validator'

/**
 * Tier 846 — optional, but not null: a field of an update that may be left
 * out and, when it is there, has a value.
 *
 * `@IsOptional()` skips every check for `null` as well as for a field that is
 * not there. For a column that takes no NULL the null then reached Prisma and
 * answered 500 (measured: `"name": null` on a customer, `"description": null`
 * on an expense, `"amount": null` on a cash book entry). With this the
 * field's own checks see the null and refuse it.
 */
export const IsOptionalNotNull = () => ValidateIf((_o, v) => v !== undefined)
