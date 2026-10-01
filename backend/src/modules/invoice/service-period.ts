import { BadRequestException } from '@nestjs/common'

/**
 * Tier 493 — the Leistungszeitraum of an invoice (§ 14 Abs. 4 Nr. 6 UStG,
 * BT-73/74). A recurring service or a project is supplied over a period,
 * not on a day; the invoice could only state one date.
 *
 * For create / update: both dates or neither, the start not after the end.
 * Neither given → {} (an update leaves the stored period alone).
 */
export function servicePeriodOf(dto: { servicePeriodStart?: string; servicePeriodEnd?: string }): {
  servicePeriodStart?: Date
  servicePeriodEnd?: Date
} {
  const { servicePeriodStart: s, servicePeriodEnd: e } = dto ?? {}
  if (!s && !e) return {}
  if (!s || !e) throw new BadRequestException('Leistungszeitraum: Beginn und Ende angeben (oder keines von beiden).')
  const start = new Date(s)
  const end = new Date(e)
  if (start > end) throw new BadRequestException('Leistungszeitraum: der Beginn liegt nach dem Ende.')
  return { servicePeriodStart: start, servicePeriodEnd: end }
}
