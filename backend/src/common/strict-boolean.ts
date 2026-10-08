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
