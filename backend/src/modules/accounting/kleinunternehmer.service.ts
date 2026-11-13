import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { businessDayIso, businessToday } from '../../common/business-date'
import { KU_SELECT, KuCompany, kuOn } from '../../common/kleinunternehmer-period'
import { EXEMPTION_HINT } from '../invoice/mandatory-details'
import { zeroRatedGround } from '../invoice/zero-rated'
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
  /** Tier 845: invoices issued without USt on a day § 19 does not cover */
  | 'ohneUmsatzsteuer'

/** Tier 845: at most this many of them are listed */
export const KU_OHNE_UST_LISTE = 20

export interface KuOhneUmsatzsteuer {
  anzahl: number
  /** their gross amounts, EUR */
  summe: number
  /** the oldest first, at most KU_OHNE_UST_LISTE */
  rechnungen: Array<{ id: string; invoiceNumber: string; issueDate: string; total: number }>
}

export interface KuStatus {
  kleinunternehmer: boolean
  jahr: number
  vorjahr: { jahr: number; umsatz: number; leer: boolean }
  laufend: { jahr: number; umsatz: number }
  grenzeVorjahr: number
  grenzeLaufend: number
  hinweise: KuHinweis[]
  ohneUmsatzsteuer: KuOhneUmsatzsteuer
}

const GESAMTUMSATZ_KZ = new Set(['4100', '4120', '4170'])

const euro = (n: number) => `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
const deDay = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`

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
    const co = await this.prisma.company.findUnique({ where: { id: companyId }, select: KU_SELECT })
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
      ohneUmsatzsteuer: { anzahl: 0, summe: 0, rechnungen: [] },
    }
    // Tier 845: also for a company that is no Kleinunternehmer any more
    out.ohneUmsatzsteuer = await this.ohneUmsatzsteuer(companyId, co)
    if (out.ohneUmsatzsteuer.anzahl > 0) out.hinweise.push('ohneUmsatzsteuer')
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

  /**
   * Tier 845 — invoices issued without USt on a day the Kleinunternehmer-
   * regelung does not cover. They come about when its end is set back over
   * invoices already issued — as Tier 843's own advice has it: „Umsatzsteuer
   * ab dem 01.01.“ once last year turns out to be over 25 000 €. Measured: a
   * § 19 invoice of August with the end set to 30.06. stood in the UStVA as
   * „sonstige steuerfreie Umsätze“ and in the EÜR on 4170, and nothing said
   * a word. It is a taxed supply: the tax is in its price and owed (§ 10
   * Abs. 1 UStG), and the customer holds an invoice that states none.
   *
   * Listed: issued invoices and receipts with no USt at all, on a day § 19
   * does not apply, that are no igL / § 13b / export and name no exemption
   * (what Tier 690 would refuse to issue today), and that no credit note has
   * taken back in full. A company that never had a § 19 period has none.
   */
  private async ohneUmsatzsteuer(companyId: string, co: KuCompany): Promise<KuOhneUmsatzsteuer> {
    const none: KuOhneUmsatzsteuer = { anzahl: 0, summe: 0, rechnungen: [] }
    const on = kuOn(co)
    const mode = co?.defaultVatMode === 'kleinunternehmer'
    const day = (d: Date) => businessDayIso(d)
    const ab = co?.kleinunternehmerAb ? day(co.kleinunternehmerAb) : null
    const bis = co?.kleinunternehmerBis ? day(co.kleinunternehmerBis) : null
    // the days § 19 does not cover that lie beside a § 19 period
    const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
    const ranges: Array<{ gt?: Date; lt?: Date }> = []
    if (mode) {
      if (!ab) return none // a Kleinunternehmer since always
      ranges.push({ lt: utc(ab), ...(bis ? { gt: utc(bis) } : {}) })
    } else {
      if (!bis) return none // never one
      ranges.push({ gt: utc(bis) })
      if (ab) ranges.push({ lt: utc(ab) })
    }
    const rows = await this.prisma.invoice.findMany({
      where: {
        companyId,
        type: { in: ['INV', 'RCV'] },
        status: { in: ['sent', 'paid', 'overdue'] },
        reverseCharge: false,
        euTransaction: false,
        totalVat: 0,
        subtotal: { gt: 0 },
        OR: ranges.map((r) => ({ issueDate: r })),
      },
      select: {
        id: true, invoiceNumber: true, issueDate: true, total: true, eurTotal: true, notes: true,
        reverseCharge: true, euTransaction: true,
        customer: { select: { address: true, vatId: true } },
      },
      orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
    })
    const open = rows.filter(
      (r) =>
        !on(r.issueDate) &&
        zeroRatedGround(r, (r.customer?.address as { country?: string } | null)?.country, r.customer?.vatId) === 'exempt' &&
        // remarks that name § 19 name no exemption
        !EXEMPTION_HINT.test((r.notes ?? '').replace(/§\s*19(?!\d)/g, '')),
    )
    if (!open.length) return none
    const credited = await this.prisma.invoice.groupBy({
      by: ['referenceInvoiceId'],
      where: { companyId, type: 'CN', status: { notIn: ['draft', 'cancelled'] }, referenceInvoiceId: { in: open.map((r) => r.id) } },
      _sum: { total: true },
    })
    const takenBack = new Map(credited.map((c) => [c.referenceInvoiceId, Math.abs(Number(c._sum.total ?? 0))]))
    const left = open.filter((r) => (takenBack.get(r.id) ?? 0) < Number(r.total) - 0.005)
    const cents = left.reduce((s, r) => s + Math.round(Number(r.eurTotal ?? r.total) * 100), 0)
    return {
      anzahl: left.length,
      summe: cents / 100,
      rechnungen: left.slice(0, KU_OHNE_UST_LISTE).map((r) => ({
        id: r.id, invoiceNumber: r.invoiceNumber, issueDate: day(r.issueDate), total: Number(r.total),
      })),
    }
  }

  /**
   * Tier 843 — an invoice issued under § 19 when the regulation no longer
   * covers it. Measured on Tier 842: a Kleinunternehmer with 30 000 € last
   * year, or with 99 000 € received this year issuing 1 500 € more, issued
   * the invoice without USt and with the § 19 note; only the dashboard's
   * notice (Tier 841) said anything. The USt is owed all the same — out of
   * the price the customer paid, as the invoice shows none.
   *
   * Refused, on the invoice's issue date when § 19 applies on it:
   *  - the previous year's Gesamtumsatz over 25 000 €: the regulation does
   *    not apply in that year at all;
   *  - the year's Gesamtumsatz received so far plus this invoice's net over
   *    100 000 €: the supply that crosses the limit is already taxed.
   * Not refused: no revenue at all in the previous year (perhaps the year the
   * business began, when 25 000 € is this year's limit — Tier 841 says so,
   * the app does not know the founding day).
   *
   * The text of the refusal, or null.
   */
  async refusalForIssue(companyId: string, issueDate: Date | string, net: number): Promise<string | null> {
    return (await this.issueCheck(companyId, issueDate))(net)
  }

  /**
   * The check of `refusalForIssue` for one issue date, asked for its net
   * afterwards — the revenue is read here, before a caller's transaction
   * (a recurring run's), not inside it.
   */
  async issueCheck(companyId: string, issueDate: Date | string): Promise<(net: number) => string | null> {
    const co = await this.prisma.company.findUnique({ where: { id: companyId }, select: KU_SELECT })
    const day = typeof issueDate === 'string' ? issueDate.slice(0, 10) : businessDayIso(issueDate)
    if (!kuOn(co)(day)) return () => null
    const jahr = Number(day.slice(0, 4))
    const then = 'Stellen Sie in den Einstellungen die Umsatzsteuer ab'
    // a draft is edited on its issue day only (Tier 477 / 697); an older one is made anew
    const after =
      'ein (Standard-Umsatzsteuer) und stellen Sie die Rechnung mit Umsatzsteuer aus — den Steuersatz im Entwurf ändern ' +
      'oder, ist er nicht von heute, die Rechnung neu anlegen.'
    const vorjahr = await this.gesamtumsatz(companyId, jahr - 1)
    if (vorjahr > KU_GRENZE_VORJAHR) {
      return () => (
        `Die Kleinunternehmerregelung gilt ${jahr} nicht: Der Gesamtumsatz ${jahr - 1} betrug ${euro(vorjahr)}, ` +
        `mehr als ${euro(KU_GRENZE_VORJAHR)} (§ 19 Abs. 1 UStG). Diese Rechnung muss Umsatzsteuer ausweisen — ` +
        `ohne sie schulden Sie die Steuer trotzdem, aus dem Rechnungsbetrag. ${then} dem 01.01.${jahr} ${after}`
      )
    }
    const laufend = await this.gesamtumsatz(companyId, jahr)
    return (net: number) => {
      const cents = Math.round(laufend * 100) + Math.round(net * 100)
      if (cents > KU_GRENZE_LAUFEND * 100) {
        const crossing = Math.round(laufend * 100) <= KU_GRENZE_LAUFEND * 100
        return (
          (crossing
            ? `Mit dieser Rechnung (netto ${euro(net)}) übersteigt der Gesamtumsatz ${jahr} ${euro(KU_GRENZE_LAUFEND)}: ` +
              `vereinnahmt sind bereits ${euro(laufend)} (§ 19 Abs. 1 UStG). Der Umsatz, mit dem die Grenze überschritten wird, ` +
              `ist bereits steuerpflichtig, und jeder danach.`
            : `Der Gesamtumsatz ${jahr} hat ${euro(KU_GRENZE_LAUFEND)} überschritten: vereinnahmt sind ${euro(laufend)} ` +
              `(§ 19 Abs. 1 UStG). Seit dem Umsatz, mit dem die Grenze überschritten wurde, gilt die Kleinunternehmerregelung nicht mehr.`) +
          ` Diese Rechnung muss Umsatzsteuer ausweisen. ${then} dem ${crossing ? deDay(day) : 'Tag des Umsatzes, mit dem die Grenze überschritten wurde,'} ${after}`
        )
      }
      return null
    }
  }
}
