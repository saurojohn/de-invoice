import { BadRequestException } from '@nestjs/common'
import { Transform } from 'class-transformer'

/**
 * Tier 606 — a boolean in a request is a boolean, or the words for one.
 *
 * The ValidationPipe runs with `enableImplicitConversion`, and for a property
 * typed `boolean` that conversion is `Boolean(value)`: every non-empty string
 * and every number but 0 became `true` before `@IsBoolean()` looked at it.
 * Measured: `{"taxExempt": "false"}` stored a tax-exempt customer,
 * `{"creditNote": "false"}` a credit note with negative amounts,
 * `{"isReverseCharge": "vielleicht"}` a § 13b expense. (The application's
 * own pages send real booleans; an integration that sends strings — a form
 * post, a CSV tool — got the opposite of what it asked for.)
 *
 * This reads the value as it was sent (`obj[key]`, not the converted one):
 * true / "true" / "1" / 1 and false / "false" / "0" / 0 are what they say;
 * anything else is handed on unchanged, so `@IsBoolean()` refuses it.
 * Put it on every `@IsBoolean()` property.
 */
export const StrictBoolean = () =>
  Transform(({ obj, key }) => {
    const raw = (obj as Record<string, unknown> | undefined)?.[key]
    if (raw === true || raw === 'true' || raw === '1' || raw === 1) return true
    if (raw === false || raw === 'false' || raw === '0' || raw === 0) return false
    return raw
  })

/**
 * Tier 632: the same reading for a flag in a body that is no validated class
 * (an inline type gets no ValidationPipe): true / false and their spellings
 * as `StrictBoolean` reads them, `undefined` when the flag is absent — and a
 * 400 for anything else, instead of JavaScript's "every non-empty string is
 * true" (`"false"` switched FinTS's demo bank on and a dry run).
 */
export function strictFlag(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (value === true || value === 'true' || value === '1' || value === 1) return true
  if (value === false || value === 'false' || value === '0' || value === 0) return false
  throw new BadRequestException(`${name} muss true oder false sein`)
}
