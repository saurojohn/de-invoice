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

/**
 * Tier 930 — a Leistungsdatum / Leistungszeitraum within reason. Since Tier
 * 912 it decides the VAT period: a typo moved the tax silently — measured,
 * 1990-01-01 and 2099-12-31 were taken and issued (the tax in a period no one
 * files, or decades ahead). Before the issue date: at most ten years (§ 147
 * Abs. 3 AO, § 169 AO — nothing older is declared any more); after it: at
 * most three (an advance invoice for a delivery further ahead is no invoice
 * of a supply). The form warns from one year on.
 */
export function assertSupplyInRange(issueDate: Date, days: Array<Date | null | undefined>): void {
  const day = (d: Date) => d.toISOString().slice(0, 10)
  const shift = (y: number) => { const d = new Date(issueDate); d.setUTCFullYear(d.getUTCFullYear() + y); return day(d) }
  const earliest = shift(-10)
  const latest = shift(3)
  for (const d of days) {
    if (!d || Number.isNaN(d.getTime())) continue
    const v = day(d)
    if (v < earliest || v > latest) {
      const de = (s: string) => s.split('-').reverse().join('.')
      throw new BadRequestException(
        `Das Leistungsdatum ${de(v)} liegt ${v < earliest ? 'mehr als zehn Jahre vor' : 'mehr als drei Jahre nach'} dem Rechnungsdatum — ` +
        'bitte prüfen (es bestimmt den Zeitraum der Umsatzsteuer).',
      )
    }
  }
}
