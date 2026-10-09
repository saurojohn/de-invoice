import { Transform } from 'class-transformer'

/**
 * Tier 633 — a number in a request is a number, or the digits for one.
 *
 * The ValidationPipe converts implicitly, and for a property typed number
 * that is Number(value) before any decorator sees it: `true` arrived as 1
 * (measured: a payment of 1 € from `{"amount": true}`, an invoice line at
 * 1 € from `{"unitPrice": true}`), and `""` as 0 (a product priced 0, a
 * customer's credit limit and payment terms set to 0 by an empty field).
 * This reads the value as it was sent:
 *   a number            → itself
 *   digits in a string  → the number (forms and query strings send strings)
 *   an empty string     → not given (an optional field stays untouched, a
 *                         required one is refused)
 *   anything else       → as it is, so @IsNumber / @IsInt refuse it
 * It stands in front of every @IsNumber() and @IsInt(); spec 362 keeps it there.
 */
const DIGITS = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

export const StrictNumber = () =>
  Transform(({ obj, key, value }) => {
    const raw = (obj as Record<string, unknown> | undefined)?.[key]
    // A number, or nothing: whatever the property's own transforms made of it
    // (a VAT rate sent as 19 has become 0.19 by then) — this one only steps in
    // where the raw value is not a number.
    if (typeof raw === 'number' || raw === undefined || raw === null) return value
    if (typeof raw !== 'string') return raw // true, [], {} — @IsNumber refuses
    const text = raw.trim()
    if (text === '') return undefined
    if (!DIGITS.test(text)) return raw
    return typeof value === 'number' && Number.isFinite(value) ? value : Number(text)
  })
