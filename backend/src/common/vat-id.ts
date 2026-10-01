import { BadRequestException } from '@nestjs/common'

/**
 * Tier 490 — the format of an EU VAT identification number (USt-IdNr.).
 *
 * The number is stored as typed: "fr 12 345 678 901" stayed with spaces and
 * lower case, "FR1" and the Greek "GR123456789" (Greece's prefix is EL) were
 * taken — and Tier 486's igL check, which reads the prefix only, accepted
 * them. A malformed number in the Zusammenfassende Meldung is rejected by
 * the BZSt, and an igL to it is not tax-free. Patterns: the VIES formats per
 * member state (plus XI, Northern Ireland). Numbers of non-EU countries
 * (e.g. Swiss CHE…) are left alone.
 */

const FORMATS: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
  XI: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
}

/** Upper case, without spaces, dots, dashes; null for an empty value. */
export function normalizeVatId(vatId: string | null | undefined): string | null {
  if (vatId == null) return null
  const v = String(vatId).replace(/[\s.-]/g, '').toUpperCase()
  return v || null
}

/** Why the number is no valid EU USt-IdNr. format, or null (also for non-EU numbers). */
export function vatIdFormatProblem(vatId: string | null | undefined): string | null {
  const v = normalizeVatId(vatId)
  if (!v) return null
  const prefix = v.slice(0, 2)
  if (prefix === 'GR') return `USt-IdNr. ${v}: Griechenland hat das Präfix EL, nicht GR.`
  const re = FORMATS[prefix]
  if (!re) return null
  if (!re.test(v.slice(2))) return `USt-IdNr. ${v} hat nicht das Format einer ${prefix}-Nummer.`
  return null
}

/**
 * For a create / update payload: a given `vatId` normalised, or a 400 when
 * it is no valid EU format. Payloads without the field pass unchanged.
 */
export function withCheckedVatId<T extends { vatId?: string | null }>(data: T): T {
  if (!data || !('vatId' in data)) return data
  const problem = vatIdFormatProblem(data.vatId)
  if (problem) throw new BadRequestException(problem)
  return { ...data, vatId: normalizeVatId(data.vatId) }
}
