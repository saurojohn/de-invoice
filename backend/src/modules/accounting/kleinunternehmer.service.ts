import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { businessToday } from '../../common/business-date'
import { EuerService } from './euer.service'

/**
 * Tier 841 — the limits of the Kleinunternehmerregelung (§ 19 UStG since
 * 01.01.2025, BMF-Schreiben vom 18.03.2025):
 *
 *  - the Gesamtumsatz of the previous calendar year not above 25 000 €, and
 *  - that of the current year not above 100 000 €.
 *
 * Both are net amounts (a Kleinunternehmer charges no USt) of the Entgelte
 * received (vereinnahmte Entgelte, § 19 Abs. 2 UStG). Over 25 000 € last year,
 * the regulation does not apply this year at all. Over 100 000 € this year,
 * it ends at once: the supply that crosses the limit is already taxed, and so
 * is every one after it; the earlier ones stay exempt. In the year the
 * business begins, 25 000 € is the limit of that year.
 *
 * Measured before: a Kleinunternehmer with 30 000 € in 2025 and 105 000 € in
 * 2026 went on writing invoices without USt; nothing said a word.
 *
 * The Gesamtumsatz here is the EÜR's revenue received (euer-zufluss.ts):
 * Kz 4100 (taxed), 4120 (§ 19) and 4170 (tax-free). It counts on the safe
 * side: the tax-free supplies § 19 Abs. 2 leaves out (§ 4 Nr. 8 i, 9 b,
 * 11 – 28, e.g. a rent under Nr. 12) and the sale of an asset are in it if
 * they were invoiced, as the app cannot tell them apart. What the app does
 * not hold (receipts before the company used it) is not in it — `vorjahrLeer`
 * says when the previous year has no revenue at all.
 */
export const KU_GRENZE_VORJAHR = 25_000
export const KU_GRENZE_LAUFEND = 100_000
/** a warning from this much of the current year's limit on */
export const KU_WARNSCHWELLE = 90_000

export type KuHinweis =
  /** last year over 25 000 €: not a Kleinunternehmer this year */
  | 'vorjahrUeberschritten'
  /** this year over 100 000 €: regular taxation since the crossing supply */
  | 'laufendUeberschritten'
  /** this year near 100 000 € */
  | 'laufendNahe'
  /** this year over 25 000 €: not a Kleinunternehmer next year */
  | 'naechstesJahr'
  /** …and no revenue last year: if the business began this year, 25 000 € was this year's limit */
  | 'gruendungsjahr'

export interface KuStatus {
  kleinunternehmer: boolean
  jahr: number
  vorjahr: { jahr: number; umsatz: number; leer: boolean }
  laufend: { jahr: number; umsatz: number }
  grenzeVorjahr: number
  grenzeLaufend: number
  hinweise: KuHinweis[]
}

const GESAMTUMSATZ_KZ = new Set(['4100', '4120', '4170'])

@Injectable()
export class KleinunternehmerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly euer: EuerService,
  ) {}

  private async gesamtumsatz(companyId: string, year: number): Promise<number> {
    const r = await this.euer.compute(companyId, year)
    const cents = r.einnahmen
      .filter((l) => GESAMTUMSATZ_KZ.has(l.kennziffer))
      .reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0)
    return cents / 100
  }

  async status(companyId: string): Promise<KuStatus> {
    const co = await this.prisma.company.findUnique({ where: { id: companyId }, select: { defaultVatMode: true } })
    const kleinunternehmer = co?.defaultVatMode === 'kleinunternehmer'
    const jahr = businessToday().y
    const out: KuStatus = {
      kleinunternehmer,
      jahr,
      vorjahr: { jahr: jahr - 1, umsatz: 0, leer: true },
      laufend: { jahr, umsatz: 0 },
      grenzeVorjahr: KU_GRENZE_VORJAHR,
      grenzeLaufend: KU_GRENZE_LAUFEND,
      hinweise: [],
    }
    if (!kleinunternehmer) return out
    const [vorjahr, laufend] = await Promise.all([this.gesamtumsatz(companyId, jahr - 1), this.gesamtumsatz(companyId, jahr)])
    out.vorjahr = { jahr: jahr - 1, umsatz: vorjahr, leer: vorjahr === 0 }
    out.laufend.umsatz = laufend
    if (vorjahr > KU_GRENZE_VORJAHR) out.hinweise.push('vorjahrUeberschritten')
    if (laufend > KU_GRENZE_LAUFEND) out.hinweise.push('laufendUeberschritten')
    else if (laufend > KU_WARNSCHWELLE) out.hinweise.push('laufendNahe')
    if (laufend > KU_GRENZE_VORJAHR) {
      out.hinweise.push('naechstesJahr')
      if (vorjahr === 0) out.hinweise.push('gruendungsjahr')
    }
    return out
  }
}
