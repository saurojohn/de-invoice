import { flowFromLeft } from '../../common/pdf-flow'
import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Anlage Kind — the children of a year, what Kindergeld they are entitled
 * to and the Freibeträge of § 32 Abs. 6 EStG.
 *
 * Tier 672 — read against §§ 31, 32, 66 EStG (gesetze-im-internet.de,
 * 12.10.2026):
 *   § 66 Abs. 1    Kindergeld is a MONTHLY amount — 259 € a child in 2026
 *                  (255 € in 2025, 250 € in 2023/24; 219/219/225/250 € by
 *                  the child's rank in 2021/22).
 *   § 32 Abs. 6    Kinderfreibetrag 3 414 € and 1 464 € for care, upbringing
 *                  or training — for EACH parent and year; doubled for
 *                  spouses assessed together; one twelfth less for every
 *                  month in which the child is not counted.
 *   § 32 Abs. 3    A child counts from the month of its birth and in every
 *                  month at whose beginning it is not yet 18;
 *   § 32 Abs. 4    after that only under conditions (in training …), and
 *                  not beyond 25.
 *   § 31 Satz 4    The Freibeträge are not granted on top of the Kindergeld:
 *                  the tax office takes whichever is better.
 *
 * Before: the monthly 250 € was the year's Kindergeld (3 000 € were 250 €);
 * the Freibetrag was 6 612 € (two parents, 2024) plus 1 320 € (one parent,
 * the amount up to 2020) for every year; every child in the list counted —
 * a 35-year-old, a child born in August for twelve months, one marked as
 * not entitled — and „Net (FB − KG)“ subtracted a monthly payment from a
 * deduction from income.
 *
 * Data: Company.settings.kinder[year] = [{ name, birthDate,
 * kindergeldEligible }]. For a child of age the flag says that the
 * conditions of § 32 Abs. 4 are met.
 */

/** Per parent and year (§ 32 Abs. 6 Satz 1), and Kindergeld a month by the child's rank (§ 66 Abs. 1). */
interface KindSaetze { kinderfreibetrag: number; bea: number; kindergeld: [number, number, number, number] }
const SAETZE: Record<number, KindSaetze> = {
  2021: { kinderfreibetrag: 2730, bea: 1464, kindergeld: [219, 219, 225, 250] },
  2022: { kinderfreibetrag: 2810, bea: 1464, kindergeld: [219, 219, 225, 250] },
  2023: { kinderfreibetrag: 3012, bea: 1464, kindergeld: [250, 250, 250, 250] },
  2024: { kinderfreibetrag: 3306, bea: 1464, kindergeld: [250, 250, 250, 250] },
  2025: { kinderfreibetrag: 3336, bea: 1464, kindergeld: [255, 255, 255, 255] },
  2026: { kinderfreibetrag: 3414, bea: 1464, kindergeld: [259, 259, 259, 259] },
}
const ERSTES_JAHR = 2021
const LETZTES_JAHR = 2026

/** The amounts of a year; `stand` is the year they are of (the nearest one stored). */
export function kindSaetzeFor(year: number): KindSaetze & { stand: number } {
  const stand = Math.min(LETZTES_JAHR, Math.max(ERSTES_JAHR, year))
  return { ...SAETZE[stand], stand }
}

export type KindGrund = 'geburtsdatum' | 'keinAnspruch' | 'nochNichtGeboren' | 'ueber25' | 'volljaehrigOhneNachweis' | null

/**
 * The months of `year` in which a child is counted (1…12), § 32 Abs. 3 and 4.
 * A birthday on the first of a month completes the year of life the day
 * before (§ 187 Abs. 2 BGB) — that month no longer counts.
 */
export function kindMonate(
  birthDate: string,
  year: number,
  berechtigt: boolean,
): { monate: number[]; grund: KindGrund } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate || '')) return { monate: [], grund: 'geburtsdatum' }
  if (!berechtigt) return { monate: [], grund: 'keinAnspruch' }
  const [by, bm, bd] = birthDate.split('-').map(Number)
  const completed = (age: number, month: number): boolean => {
    // the day the child turns `age`, against the first of the month
    const birthday = (by + age) * 10000 + bm * 100 + bd
    return birthday <= year * 10000 + month * 100 + 1
  }
  const monate: number[] = []
  let sawAdultMonth = false
  for (let m = 1; m <= 12; m++) {
    if (year * 100 + m < by * 100 + bm) continue // not born yet
    if (completed(25, m)) continue
    if (completed(18, m)) sawAdultMonth = true
    monate.push(m)
  }
  if (monate.length === 0) return { monate, grund: year * 100 + 12 < by * 100 + bm ? 'nochNichtGeboren' : 'ueber25' }
  return { monate, grund: sawAdultMonth ? 'volljaehrigOhneNachweis' : null }
}

export interface Kind {
  name: string
  birthDate: string // ISO date (YYYY-MM-DD)
  kindergeldEligible: boolean
  /** the months of the year in which the child is counted */
  monate: number
  /** why it is not counted, or for how long: see KindGrund */
  grund: KindGrund
}

export interface AnlageKindLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

export interface AnlageKindResult {
  year: number
  companyId: string
  kinder: Kind[]
  einnahmen: AnlageKindLine[]
  ausgaben: AnlageKindLine[]
  totals: {
    /** the children counted in at least one month */
    anzahlKinder: number
    /** the Kindergeld of the year: the monthly amount for every month counted */
    kindergeldTotal: number
    /** the Freibeträge of § 32 Abs. 6, by months, for one parent or both */
    freibetragTotal: number
    kindermonate: number
  }
  /** the amounts used, the year they are of, and whether doubled for spouses assessed together */
  saetze: { stand: number; kinderfreibetrag: number; bea: number; kindergeld: number[]; zusammenveranlagung: boolean }
  counts: {
    hasKinder: boolean
  }
  generatedAt: string
  disclaimer: string
}

// The lines. 6600+ are this preview's own numbers.
const AUSGABEN_PLACEHOLDERS: Array<{ kz: string; label: string; note: string }> = [
  {
    kz: '6630',
    label: 'Volljährige Kinder in Berufsausbildung (§ 32 Abs. 4 EStG) — Nachweis',
    note: 'Wird nicht geprüft. Ein volljähriges Kind zählt hier, wenn es als berechtigt eingetragen ist; der Berater ergänzt den Nachweis (Schul-, Ausbildungs- oder Studienbescheinigung).',
  },
  {
    kz: '6640',
    label: 'Behinderten-Pauschbetrag des Kindes (§ 33b EStG)',
    note: 'Wird nicht berechnet. Der Berater ergänzt ihn aus dem Feststellungsbescheid (ab einem Grad der Behinderung von 20, § 33b Abs. 3 EStG).',
  },
]

/** A child's line of the PDF: for how many months it counts, or why not. */
function kindZeile(k: Kind): string {
  if (k.grund === 'geburtsdatum') return 'nicht berücksichtigt: Geburtsdatum fehlt'
  if (k.grund === 'keinAnspruch') return 'nicht berücksichtigt: als nicht berechtigt eingetragen'
  if (k.grund === 'nochNichtGeboren') return 'nicht berücksichtigt: in diesem Jahr noch nicht geboren'
  if (k.grund === 'ueber25') return 'nicht berücksichtigt: das 25. Lebensjahr vollendet'
  const monate = `${k.monate} ${k.monate === 1 ? 'Monat' : 'Monate'}`
  return k.grund === 'volljaehrigOhneNachweis' ? `${monate} (volljährig — Nachweis nach § 32 Abs. 4 EStG erforderlich)` : monate
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class AnlageKindService {
  constructor(private prisma: PrismaService) {}

  /**
   * Compute the Anlage Kind for the year. Returns
   * the report JSON. The controller wraps this
   * in the year-defaults + auth handling.
   *
   * v1: read the Kinder list from
   * Company.settings.kinder[year]. Apply the
   * standard Kindergeld (250 EUR/Kind) +
   * Kinderfreibetrag (7,932 EUR/Kind) per year.
   */
  async compute(companyId: string, year: number): Promise<AnlageKindResult> {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    const settings = (company?.settings as any) || {}

    // § 32 Abs. 6 Satz 2: doubled for spouses assessed together (the same
    // choice as on Anlage KAP)
    const zusammenveranlagung = settings.zusammenveranlagung === true
    const faktor = zusammenveranlagung ? 2 : 1
    const saetze = kindSaetzeFor(year)

    // The children of the year, each with the months in which it counts
    const kinderAll = (settings.kinder as any) || {}
    const raw = kinderAll[year] || []
    const listed = (Array.isArray(raw) ? raw : [])
      .filter((k: any) => k && typeof k === 'object')
      .map((k: any) => {
        const birthDate = typeof k.birthDate === 'string' ? k.birthDate : ''
        const kindergeldEligible = k.kindergeldEligible !== false // default true
        const { monate, grund } = kindMonate(birthDate, year, kindergeldEligible)
        return { name: String(k.name || '').trim() || 'Kind', birthDate, kindergeldEligible, months: monate, grund }
      })
    const kinder: Kind[] = listed.map(({ months, ...k }) => ({ ...k, monate: months.length }))
    const hasKinder = kinder.length > 0
    const counted = listed.filter((k) => k.months.length > 0)
    const anzahlKinder = counted.length
    const kindermonate = counted.reduce((sum, k) => sum + k.months.length, 0)

    // § 66: a month's Kindergeld for every child counted in it — the amount by
    // the child's rank among them, the eldest first (it differed up to 2022)
    const byAge = [...counted].sort((x, y) => x.birthDate.localeCompare(y.birthDate))
    let kindergeldTotal = 0
    for (let m = 1; m <= 12; m++) {
      byAge.filter((k) => k.months.includes(m)).forEach((_k, rank) => {
        kindergeldTotal += saetze.kindergeld[Math.min(rank, 3)]
      })
    }
    kindergeldTotal = round2(kindergeldTotal)

    const eur = (n: number): string => new Intl.NumberFormat('de-DE').format(n)
    // said once, on the first line: it holds for the Freibeträge too
    const standNote = saetze.stand !== year ? ` Hinterlegt sind die Beträge von ${saetze.stand} (Kindergeld und Freibeträge); für ${year} gelten andere.` : ''
    const sameForAll = new Set(saetze.kindergeld).size === 1
    const einnahmen: AnlageKindLine[] = [
      {
        kennziffer: '6600',
        label: sameForAll
          ? `Kindergeld (§ 66 EStG): ${eur(saetze.kindergeld[0])} EUR je Kind und Monat`
          : `Kindergeld (§ 66 EStG): ${eur(saetze.kindergeld[0])} EUR je Monat für das erste und zweite Kind, ${eur(saetze.kindergeld[2])} EUR für das dritte, ${eur(saetze.kindergeld[3])} EUR ab dem vierten`,
        amount: kindergeldTotal,
        source: 'computed',
        note: `Anspruch für ${kindermonate} Kindermonate.${standNote}`,
      },
    ]

    // § 32 Abs. 6: per parent and year, by twelfths
    const zwoelftel = kindermonate / 12
    const elternNote = zusammenveranlagung
      ? 'Für zusammen veranlagte Eltern verdoppelt (§ 32 Abs. 6 Satz 2 EStG); je Monat, in dem das Kind nicht berücksichtigt wird, ein Zwölftel weniger.'
      : 'Betrag eines Elternteils — bei Zusammenveranlagung verdoppelt er sich; je Monat, in dem das Kind nicht berücksichtigt wird, ein Zwölftel weniger.'
    const ausgaben: AnlageKindLine[] = [
      {
        kennziffer: '6610',
        label: `Kinderfreibetrag für das sächliche Existenzminimum (§ 32 Abs. 6 EStG): ${eur(saetze.kinderfreibetrag)} EUR je Elternteil und Jahr`,
        amount: round2(saetze.kinderfreibetrag * faktor * zwoelftel),
        source: 'computed',
        note: elternNote,
      },
      {
        kennziffer: '6620',
        label: `Freibetrag für den Betreuungs- und Erziehungs- oder Ausbildungsbedarf (§ 32 Abs. 6 EStG): ${eur(saetze.bea)} EUR je Elternteil und Jahr`,
        amount: round2(saetze.bea * faktor * zwoelftel),
        source: 'computed',
        note: elternNote,
      },
      ...AUSGABEN_PLACEHOLDERS.map((d) => ({
        kennziffer: d.kz,
        label: d.label,
        amount: 0,
        source: 'placeholder' as const,
        note: d.note,
      })),
    ]
    const freibetragTotal = round2(ausgaben.reduce((sum, l) => sum + l.amount, 0))

    return {
      year,
      companyId,
      kinder,
      einnahmen,
      ausgaben,
      totals: {
        anzahlKinder,
        kindergeldTotal,
        freibetragTotal,
        kindermonate,
      },
      saetze: {
        stand: saetze.stand,
        kinderfreibetrag: saetze.kinderfreibetrag,
        bea: saetze.bea,
        kindergeld: saetze.kindergeld,
        zusammenveranlagung,
      },
      counts: {
        hasKinder,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde aus Ihrer Kinder-Liste (erfasst unter Buchhaltung, Anlage Kind) erstellt. ' +
        'Ein Kind zählt ab dem Monat seiner Geburt und in jedem Monat, zu dessen Beginn es noch nicht 18 ist ' +
        '(§ 32 Abs. 3 EStG); ein volljähriges Kind nur unter den Voraussetzungen des § 32 Abs. 4 EStG — hier, ' +
        'wenn es als berechtigt eingetragen ist — und längstens bis 25. ' +
        'Das Kindergeld ist der monatliche Betrag für jeden dieser Monate (§ 66 EStG). ' +
        'Die Freibeträge des § 32 Abs. 6 EStG gelten je Elternteil und Jahr und werden für zusammen veranlagte ' +
        'Eltern verdoppelt. Sie werden nicht zusätzlich zum Kindergeld gewährt: das Finanzamt setzt an, was ' +
        'günstiger ist, und rechnet den Kindergeldanspruch dann der Steuer hinzu (§ 31 Satz 4 EStG) — ' +
        'der Steuerberater prüft das. ' +
        'Nicht berücksichtigt: die Übertragung von Freibeträgen zwischen den Elternteilen, Kinder mit Behinderung ' +
        'über 25, der Entlastungsbetrag für Alleinerziehende, Einmalzahlungen zum Kindergeld (Kinderbonus).',
    }
  }

  /**
   * Render the Anlage Kind as a GoBD-style A4 PDF.
   * Same layout family as the other Anlagen:
   * header + Kinder list + 2 tables (Einnahmen +
   * Freibetrag) + summary + disclaimer + footer.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = flowFromLeft(new PDFDocument({ size: 'A4', margin: 40 }))
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-Kind-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage Kind ${year} — VORSCHAU`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Kinder, Kindergeld und Freibeträge (§§ 31, 32, 66 EStG) — ${company?.name || companyId}`,
      )
      .moveDown(1)

    if (data.counts.hasKinder) {
      doc.fontSize(12).font('Helvetica-Bold').text('Kinder im Haushalt')
      doc.moveDown(0.3)
      doc.fontSize(9).font('Helvetica')
      for (const k of data.kinder) {
        doc.text(`• ${k.name}${k.birthDate ? ` (geb. ${k.birthDate.slice(8, 10)}.${k.birthDate.slice(5, 7)}.${k.birthDate.slice(0, 4)})` : ''} — ${kindZeile(k)}`)
      }
      doc.moveDown(1)
    } else {
      doc
        .fontSize(10)
        .font('Helvetica-Oblique')
        .fillColor('#b45309')
        .text(
          '⚠ Keine Kinder für dieses Jahr erfasst. Tragen Sie unten die ' +
            'Kinder aus Ihrer Lohnsteuerbescheinigung / Kindergeldbescheid ein.',
        )
        .fillColor('#000')
      doc.moveDown(1)
    }

    // Einnahmen
    doc.fontSize(12).font('Helvetica-Bold').text('Kindergeld (§ 66 EStG)')
    doc.moveDown(0.3)
    this.renderTable(
      doc,
      data.einnahmen,
      data.totals.kindergeldTotal,
      'Kindergeld',
    )
    doc.moveDown(0.8)

    // Ausgaben / Freibetrag
    doc.fontSize(12).font('Helvetica-Bold').text('Freibeträge für Kinder (§ 32 Abs. 6 EStG)')
    doc.moveDown(0.3)
    this.renderTable(
      doc,
      data.ausgaben,
      data.totals.freibetragTotal,
      'Kinderfreibetrag',
    )
    doc.moveDown(1)

    // Summary
    doc.fontSize(13).font('Helvetica-Bold')
    doc.text(
      `Berücksichtigte Kinder: ${data.totals.anzahlKinder}  |  Kindergeld: ${this.fmtEur(data.totals.kindergeldTotal)} €  |  Freibeträge: ${this.fmtEur(data.totals.freibetragTotal)} €`,
    )
    doc
      .fontSize(9)
      .font('Helvetica')
      .text('Das Finanzamt setzt an, was günstiger ist — das Kindergeld oder die Freibeträge (§ 31 EStG), nicht beides.')
    doc.moveDown(1)

    // Disclaimer
    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .fillColor('#666')
      .text(data.disclaimer, { width: 515 })
      .fillColor('#000')

    // Footer
    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#999')
      .text(
        `Erstellt: ${new Date(data.generatedAt).toLocaleString('de-DE')}  |  ` +
          `de-invoice · Anlage Kind Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: AnlageKindLine[],
    total: number,
    blockLabel: string,
  ): void {
    const tableTop = doc.y
    const colKz = 40
    const colAmount = 420

    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Kz', colKz, tableTop, { continued: true })
    doc.text('Bezeichnung', colKz + 35, tableTop, { continued: true })
    doc.text('Betrag (€)', colAmount, tableTop, { width: 135, align: 'right' })
    doc.moveDown(0.3)

    doc.font('Helvetica')
    for (const l of lines) {
      const y = doc.y
      doc.fontSize(9)
      doc.text(l.kennziffer, colKz, y)
      doc.text(l.label, colKz + 35, y, { width: 320 })
      doc.text(this.fmtEur(l.amount), colAmount, y, {
        width: 135,
        align: 'right',
      })
      doc.moveDown(0.2)
      if (l.note) {
        doc
          .fontSize(7)
          .fillColor('#666')
          .text(`Hinweis: ${l.note}`, colKz + 35, doc.y, { width: 380 })
          .fillColor('#000')
          .fontSize(9)
        doc.moveDown(0.2)
      }
    }

    doc.moveTo(colKz, doc.y).lineTo(555, doc.y).stroke()
    doc.moveDown(0.2)
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text(`Summe ${blockLabel}`, colKz + 35, doc.y, { width: 320 })
    doc.text(this.fmtEur(total), colAmount, doc.y, {
      width: 135,
      align: 'right',
    })
    doc.font('Helvetica').fontSize(9)
  }

  private fmtEur(n: number): string {
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }
}
