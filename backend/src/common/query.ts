import { BadRequestException } from '@nestjs/common'

/**
 * Tier 532 — query parameters that reach the database are checked first.
 *
 * Measured: 17 GET routes answered 500 to `?from=abc`, `?date=2026-02-30`,
 * `?page=-1`, `?year=99999` … — `new Date('abc')` / `parseInt('abc')` went
 * into Prisma as an Invalid Date or NaN. These helpers answer 400 and name
 * the parameter. An empty or missing value is "not given".
 */
const given = (v: unknown) => v !== undefined && v !== null && v !== ''

/** A date ("2026-09-30" or an ISO timestamp) between 1900 and 2200, or undefined when not given. */
export function queryDate(v: unknown, name: string): Date | undefined {
  if (!given(v)) return undefined
  if (typeof v !== 'string') throw new BadRequestException(`${name} ist kein gültiges Datum`)
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} ist kein gültiges Datum`)
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  // "2026-02-30" parses to 2 March in some engines — the day must survive the round trip.
  const sameDay = !dayOnly || /T/.test(v) || d.toISOString().slice(0, 10) === `${dayOnly[1]}-${dayOnly[2]}-${dayOnly[3]}`
  if (!sameDay || d.getUTCFullYear() < 1900 || d.getUTCFullYear() > 2200) {
    throw new BadRequestException(`${name} ist kein gültiges Datum`)
  }
  return d
}

export function requiredQueryDate(v: unknown, name: string): Date {
  const d = queryDate(v, name)
  if (!d) throw new BadRequestException(`${name} ist erforderlich`)
  return d
}

/** A whole number within [min, max], or undefined when not given. */
export function queryInt(
  v: unknown,
  name: string,
  range: { min?: number; max?: number } = {},
): number | undefined {
  if (!given(v)) return undefined
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = range
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new BadRequestException(`${name} muss eine ganze Zahl zwischen ${min} und ${max} sein`)
  }
  return n
}

export function requiredQueryInt(v: unknown, name: string, range: { min?: number; max?: number } = {}): number {
  const n = queryInt(v, name, range)
  if (n === undefined) throw new BadRequestException(`${name} ist erforderlich`)
  return n
}

export const YEAR = { min: 1900, max: 2200 }
export const MONTH = { min: 1, max: 12 }
