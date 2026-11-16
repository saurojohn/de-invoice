import { registerDecorator, ValidationOptions } from 'class-validator'

/**
 * Tier 846 — a number with at most `n` decimal places.
 *
 * class-validator's `@IsNumber({ maxDecimalPlaces })` reads the places off
 * the number's text and throws on one in exponent notation: `1e-9` as a
 * price, a VAT rate or an exchange rate answered 500 („Cannot read properties
 * of undefined (reading 'length')“, measured 16.11.2026). This compares the
 * value with itself rounded; what is no finite number is left to @IsNumber.
 */
export function hasAtMostDecimals(v: unknown, n: number): boolean {
  if (typeof v !== 'number' || !Number.isFinite(v)) return true
  const scaled = v * 10 ** n
  return Math.abs(scaled - Math.round(scaled)) <= 1e-9 * Math.max(1, Math.abs(scaled))
}

export function MaxDecimals(n: number, options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'maxDecimals',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => hasAtMostDecimals(value, n),
        defaultMessage: (args) => `${args?.property} darf höchstens ${n} Nachkommastellen haben`,
      },
    })
}
