import { registerDecorator, ValidationOptions } from 'class-validator'

/**
 * Tier 634 — the Leitweg-ID's check digits.
 *
 * A Leitweg-ID is Grobadressierung (2–12 digits), optionally a
 * Feinadressierung (up to 30 letters or digits) and two check digits,
 * joined by hyphens. The check digits are ISO/IEC 7064 Mod 97-10 over the
 * address without hyphens, letters counted as A = 10 … Z = 35:
 *   98 − (address × 100 mod 97)
 * (04011000-1234512345-06, 991-01484-64 and KoSIT's test address
 * 991-33333TEST-33 all come out.) Tier 599 checked the shape only — an
 * address with one digit mistyped was stored and sent as the invoice's
 * BuyerReference, where the public portal rejects the invoice.
 */
export const LEITWEG_ID_SHAPE = /^[0-9]{2,12}(-[0-9A-Za-z]{1,30})?-[0-9]{2}$/

export function leitwegCheckDigits(address: string): string {
  let rest = 0
  for (const ch of address.replace(/-/g, '').toUpperCase()) {
    const value = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55) // A → 10
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97
  }
  return String(98 - ((rest * 100) % 97)).padStart(2, '0')
}

/** null when it is a Leitweg-ID; otherwise what is wrong with it */
export function leitwegIdProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !LEITWEG_ID_SHAPE.test(value)) {
    return 'Leitweg-ID: bitte im Format der Behörde angeben, z. B. 04011000-1234512345-06 (Grobadresse, ggf. Feinadresse, zwei Prüfziffern).'
  }
  const cut = value.lastIndexOf('-')
  if (leitwegCheckDigits(value.slice(0, cut)) !== value.slice(cut + 1)) {
    return 'Leitweg-ID: die Prüfziffern passen nicht zur Adresse — bitte die Leitweg-ID der Behörde noch einmal Zeichen für Zeichen vergleichen.'
  }
  return null
}

export function IsLeitwegId(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isLeitwegId',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => leitwegIdProblem(value) === null,
        defaultMessage: (args) => leitwegIdProblem(args?.value) ?? 'Leitweg-ID ungültig',
      },
    })
}
