import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 104: Anlage Kind — Freibetrag für Kinder
 * + Kindergeld (§ 32 / § 33 / § 33a EStG).
 *
 * The German tax filing for children. The 7th
 * Anlage form (after S / V / KAP / G / N / R).
 * Covers:
 *   - Kinderfreibetrag (§ 32 EStG): 6,612 EUR
 *     sächliches Existenzminimum + 1,320 EUR
 *     Betreuungs-/Erziehungs-/Ausbildungsbedarf
 *     = 7,932 EUR pro Kind (2024)
 *   - Kindergeld (§ 66 EStG): 250 EUR/Kind
 *     (1-3), 250 EUR/4. Kind = total 1,000 EUR
 *     (for 4+ Kinder, 2024)
 *   - Schulbescheinigung for over-18 children
 *     in Berufsausbildung (§ 32 Abs. 4 EStG)
 *   - Behinderung Pauschbetrag for disabled
 *     children (§ 33b EStG)
 *
 * v1: each child is { name, birthDate (ISO),
 * kindergeldEligible (default true) }. The
 * service counts them + applies the standard
 * Freibetrag + Kindergeld per year. The actual
 * BMF rates change year to year; v1 uses 2024
 * rates as default. v2: per-year rate table.
 *
 * v1 data model: Company.settings.kinder[year]
 * = [{ name, birthDate, kindergeldEligible }, ...]
 *
 * The opt-in flag `Company.settings.anlageKind
 * === true` gates whether the report is generated.
 * v1 also auto-detects Kinder in the year
 * (length of array > 0).
 */
export interface Kind {
  name: string
  birthDate: string // ISO date (YYYY-MM-DD)
  kindergeldEligible: boolean
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
    anzahlKinder: number
    kindergeldTotal: number // 250 EUR × Kinder
    freibetragTotal: number // 7,932 EUR × Kinder
    net: number // freibetragTotal - kindergeldTotal (or just the more-favorable of the two)
  }
  counts: {
    hasKinder: boolean
  }
  generatedAt: string
  disclaimer: string
}

// Tier 104: Anlage Kind Einnahmen Kennziffern 100-180.
// The actual Anlage Kind positions are Kz 6600+
// (Hauptvordruck) — for v1 we use 100+ as internal
// namespace + same labels as the BMF.
const EINNAHMEN_LINES: Array<{
  kz: string
  label: string
  perChild: number
}> = [
  {
    kz: '6600',
    label: 'Kindergeld (§ 66 EStG) — 250 EUR pro Kind (1-3), max 1.000 EUR für 4+ Kinder (Stand 2024)',
    perChild: 250,
  },
]

// Tier 104: Anlage Kind Freibetrag / Ausgaben.
// Kz 6610-6630 cover Freibeträge. v1 computes
// the sächliches Existenzminimum + BEAfA in
// 1 line (Berater ergänzt the actual breakdown
// from the BMF table for the year).
const AUSGABEN_LINES: Array<{
  kz: string
  label: string
  perChild: number
  note?: string
}> = [
  {
    kz: '6610',
    label: 'Kinderfreibetrag sächliches Existenzminimum (§ 32 Abs. 6 EStG) — 6.612 EUR pro Kind (Stand 2024)',
    perChild: 6612,
  },
  {
    kz: '6620',
    label: 'Kinderfreibetrag Betreuungs-, Erziehungs-, Ausbildungsbedarf (§ 32 Abs. 6 EStG) — 1.320 EUR pro Kind (Stand 2024)',
    perChild: 1320,
  },
  {
    kz: '6630',
    label: 'Schulbescheinigung für volljährige Kinder in Berufsausbildung (§ 32 Abs. 4 EStG)',
    perChild: 0,
    note: 'v1: keine automatische Erkennung. Berater ergänzt aus der Schulbescheinigung der Familienkasse.',
  },
  {
    kz: '6640',
    label: 'Behinderung-Pauschbetrag für behinderte Kinder (§ 33b EStG)',
    perChild: 0,
    note: 'v1: keine automatische Erkennung. Berater ergänzt aus dem Behindertenausweis (GdB ≥ 50).',
  },
]

// Standard Kindergeld (2024): 250 EUR pro Kind
// (1-3), 250 EUR/4. Kind (= 1.000 EUR total for 4+).
// v1: simple per-child rate (ignores 4+ cap).
// v2: BMF table per year.
// Tier 356: both are declared and never read. Same shape as the Vorsteuer
// accumulators in ustja.service.ts (Tier 355) — tax figures that look like
// they were meant to reach the form. Whether Anlage Kind must show
// Kindergeld / Freibetrag per child is a Steuerberater question, so these
// are kept rather than deleted.
const _KINDERGELD_PER_KIND_2024 = 250
const _FREIBETRAG_PER_KIND_2024 = 6612 + 1320 // 7,932 EUR total

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

    // Kinder list: per-year array inside
    // Company.settings.kinder
    const kinderAll = (settings.kinder as any) || {}
    const raw = kinderAll[year] || []
    const kinder: Kind[] = Array.isArray(raw)
      ? raw
        .filter((k: any) => k && typeof k === 'object')
        .map((k: any) => ({
          name: String(k.name || '').trim() || 'Kind',
          birthDate: typeof k.birthDate === 'string' ? k.birthDate : '',
          kindergeldEligible:
            k.kindergeldEligible !== false, // default true
        }))
      : []
    const hasKinder = kinder.length > 0
    const anzahlKinder = kinder.length

    // Einnahmen: Kindergeld pro Kind
    const einnahmen: AnlageKindLine[] = EINNAHMEN_LINES.map((d) => ({
      kennziffer: d.kz,
      label: d.label,
      amount: round2(d.perChild * anzahlKinder),
      source: 'computed',
    }))
    const kindergeldTotal = einnahmen.reduce((s, l) => s + l.amount, 0)

    // Ausgaben: Freibetrag pro Kind
    const ausgaben: AnlageKindLine[] = AUSGABEN_LINES.map((d) => ({
      kennziffer: d.kz,
      label: d.label,
      amount: round2(d.perChild * anzahlKinder),
      source: d.perChild === 0 ? 'placeholder' : 'computed',
      note: d.note,
    }))
    const freibetragTotal = ausgaben.reduce((s, l) => s + l.amount, 0)

    // Net: Freibetrag minus Kindergeld. The actual
    // Einkommensteuer uses the MORE FAVORABLE of
    // (Kindergeld) vs (Kinderfreibetrag × Steuersatz).
    // v1: just show both side-by-side. The Berater
    // decides which is more favorable in the
    // Festsetzung.
    const net = round2(freibetragTotal - kindergeldTotal)

    return {
      year,
      companyId,
      kinder,
      einnahmen,
      ausgaben,
      totals: {
        anzahlKinder,
        kindergeldTotal: round2(kindergeldTotal),
        freibetragTotal: round2(freibetragTotal),
        net,
      },
      counts: {
        hasKinder,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihrer Kinder-Liste ' +
        '(Company.settings.kinder[year]) + den Standard-Kindergeld- und ' +
        'Kinderfreibetrag-Sätzen 2024 generiert. Kindergeld: 250 EUR pro ' +
        'Kind (1-3), max 1.000 EUR für 4+ Kinder. Kinderfreibetrag: ' +
        '7.932 EUR pro Kind (6.612 EUR sächliches Existenzminimum + 1.320 ' +
        'EUR BEAfA). Im Einkommensteuer-Bescheid wird das MEISTGÜNSTIGE ' +
        'aus (Kindergeld) vs (Kinderfreibetrag × Steuersatz) angewendet — ' +
        'der Steuerberater prüft das. Die BMF-Sätze ändern sich jährlich ' +
        '(i.d.R. alle 2 Jahre); v1 verwendet 2024-Sätze als Default. ' +
        'v2: BMF-Tabelle pro Jahr. Für Kinder über 18 in ' +
        'Berufsausbildung: Schulbescheinigung manuell eintragen ' +
        '(Kz 6630). Für behinderte Kinder: Pauschbetrag manuell ' +
        'eintragen (Kz 6640, je nach GdB).',
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

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
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
        `Freibetrag für Kinder + Kindergeld (§ 32 / § 33 / § 33a EStG) — ${company?.name || companyId}`,
      )
      .moveDown(1)

    if (data.counts.hasKinder) {
      doc.fontSize(12).font('Helvetica-Bold').text('Kinder im Haushalt')
      doc.moveDown(0.3)
      doc.fontSize(9).font('Helvetica')
      for (const k of data.kinder) {
        doc.text(`• ${k.name}${k.birthDate ? ` (geb. ${k.birthDate})` : ''}${!k.kindergeldEligible ? ' [kein Kindergeld]' : ''}`)
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
    doc.fontSize(12).font('Helvetica-Bold').text('Kinderfreibetrag (§ 32 EStG)')
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
      `Anzahl Kinder: ${data.totals.anzahlKinder}  |  Kindergeld: ${this.fmtEur(data.totals.kindergeldTotal)} €  |  Kinderfreibetrag: ${this.fmtEur(data.totals.freibetragTotal)} €`,
    )
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
