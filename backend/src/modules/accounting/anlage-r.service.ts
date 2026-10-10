import { flowFromLeft } from '../../common/pdf-flow'
import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 103: Anlage R — Einkünfte aus Renten
 * und Bezügen (§ 22 EStG).
 *
 * The German tax filing for retirees /
 * pension recipients. The 6th Anlage form
 * (after S / V / KAP / G / N). Covers:
 *   - Leibrenten aus der gesetzlichen
 *     Rentenversicherung (DRV) — Besteuerungs-
 *     anteil (e.g. 81 % for 2026, decreasing
 *     by 1 % per year to 50 % in 2041+)
 *   - Betriebsrenten (BAV, Pensionskasse,
 *     Direktversicherung) — Besteuerungsanteil
 *     (DRV tabelle, varies by Jahr)
 *   - Riester-Renten (reguläre Besteuerung
 *     in der Auszahlungsphase)
 *   - Private Leibrenten (Ertragsanteil § 22
 *     Nr. 1 S. 3 lit. a EStG — based on Alter
 *     bei Rentenbeginn)
 *   - Sonstige Renten (Unfallrenten, etc.)
 *
 * v1: Besteuerungsanteil auto-computed from
 * the BMF table. The user enters the per-year
 * Rentenbezüge from the Rentenbescheid.
 * Ertragsanteil (private Rente) is simpler
 * than the full BMF table — v1 just uses
 * 50% for all private Rente (the post-2012
 * default). v2: full BMF table by age.
 *
 * v1 data model: Company.settings.renten[year]
 * = { drv, bav, riester, ruerup, privat, sonstige,
 *     werbungskosten: { krankheitskosten, ... } }
 *
 * The opt-in flag `Company.settings.anlageR === true`
 * gates whether the report is generated.
 * v1 also auto-detects Rentenbezüge in the year
 * (any value > 0 for drv).
 */
export interface AnlageRLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
  /** Tier 655: the pension before the share, and the share applied (percent) */
  gross?: number
  anteil?: number
}

export interface AnlageRResult {
  year: number
  companyId: string
  rentenbezuege: {
    drv: number
    bav: number
    riester: number
    ruerup: number
    privat: number
    sonstige: number
  }
  /** Tier 655: the year each pension began, and the age at the start of a
   *  private annuity — what the taxable share depends on. null: not entered. */
  beginn: { drv: number | null; ruerup: number | null; sonstige: number | null; privatAlter: number | null }
  einnahmen: AnlageRLine[]
  werbungskosten: AnlageRLine[]
  totals: {
    rentenbezuegeTotal: number // Summe raw Rentenbezüge
    besteuerungsanteil: number // BMF %
    ertragsanteil: number // % for private Rente
    einnahmenTotal: number // Summe Besteuerungsanteile
    werbungskostenTotal: number
    einkuenfte: number // Einkünfte = einnahmen - werbungskosten
  }
  counts: {
    hasRentenbezuege: boolean
  }
  generatedAt: string
  disclaimer: string
}

// Tier 103: Anlage R Einnahmen Kennziffern 100-180.
// v1: Besteuerungsanteil is the same for DRV + BAV
// + Riester (alle nach § 22 Nr. 1 S. 3 lit. a Doppel-
// buchst. aa EStG). Private Leibrenten use
// Ertragsanteil (§ 22 Nr. 1 S. 3 lit. a EStG).
// Sonstige (Unfallrenten etc.) use Besteuerungs-
// anteil by default.
// Tier 655: which rule a line follows.
//   'aa'   § 22 Nr. 1 S. 3 a) aa) — the Besteuerungsanteil of the year the
//          pension BEGAN (statutory pension, Basisrente, widow's pension …)
//   'bb'   § 22 Nr. 1 S. 3 a) bb) — the Ertragsanteil of the age at its start
//   'voll' § 22 Nr. 5 S. 1 — taxed in full (subsidised contributions)
const EINNAHMEN_LINES: Array<{
  kz: string
  label: string
  rule: 'aa' | 'bb' | 'voll'
  beginn?: 'drv' | 'ruerup' | 'sonstige'
}> = [
  { kz: '100', label: 'Leibrenten aus der gesetzlichen Rentenversicherung (DRV, DRV-Bescheid)', rule: 'aa', beginn: 'drv' },
  { kz: '110', label: 'Betriebsrenten (BAV, Pensionskasse, Direktversicherung)', rule: 'voll' },
  { kz: '120', label: 'Riester-Renten (reguläre Besteuerung in der Auszahlungsphase)', rule: 'voll' },
  { kz: '130', label: 'Rürup-Renten / Basis-Renten (Leibrenten aus privater Altersvorsorge)', rule: 'aa', beginn: 'ruerup' },
  { kz: '140', label: 'Private Leibrenten (z.B. private Rentenversicherung — Ertragsanteil nach Alter bei Rentenbeginn)', rule: 'bb' },
  { kz: '150', label: 'Sonstige Leibrenten wie die gesetzliche Rente (Witwen-/Waisenrente, berufsständische Versorgung)', rule: 'aa', beginn: 'sonstige' },
]

// Tier 103: Anlage R Werbungskosten 200-250.
// Most retirees don't have significant Werbungs-
// kosten on their Rente — but Krankheitskosten
// related to Hinterbliebenenrente can be claimed.
// v1: all placeholder for the user.
const WERBUNGSKOSTEN_LINES: Array<{ kz: string; label: string; amount: number; note?: string }> = [
  {
    kz: '200',
    label: 'Krankheitskosten im Zusammenhang mit der Rentenbezügen',
    amount: 0,
    note: 'Vom Rentner manuell einzutragen — abzugsfähig ab 1 % des Rentenbezugs (zumutbare Belastung).',
  },
  {
    kz: '210',
    label: 'Werbungskosten-Pauschbetrag (§ 9a EStG, automatisch 102 EUR)',
    amount: 102,
  },
  {
    kz: '220',
    label: 'Pflegekosten im Zusammenhang mit der Rente',
    amount: 0,
    note: 'Vom Rentner manuell einzutragen — abzugsfähig als außergewöhnliche Belastung.',
  },
  {
    kz: '230',
    label: 'Sonstige Werbungskosten (Beratung, Steuererklärung, etc.)',
    amount: 0,
    note: 'Vom Rentner manuell einzutragen.',
  },
]

/**
 * Tier 655 — the Besteuerungsanteil, § 22 Nr. 1 Satz 3 Buchst. a Doppelbuchst.
 * aa EStG (read from gesetze-im-internet.de on 10.10.2026): by the year the
 * pension BEGAN — 50 % up to 2005, two points more each year to 80 % in 2020,
 * 81 % in 2021, 82 % in 2022, then half a point a year (82,5 % in 2023) to
 * 100 % in 2058.
 *
 * Before: a table by TAX year that rose to 83 % in 2024 and then fell by a
 * point a year to 50 % in 2057 — applied to every pension whenever it began,
 * and to company and Riester pensions as well. A pension that began in 2010
 * (60 %) was taxed at 81 % in 2026; one beginning in 2040 (91 %) would have
 * been taxed at 67 %.
 */
export function besteuerungsanteil(beginn: number): number {
  if (beginn <= 2005) return 50
  if (beginn <= 2020) return 50 + (beginn - 2005) * 2
  if (beginn <= 2022) return 80 + (beginn - 2020)
  return Math.min(100, 82 + (beginn - 2022) * 0.5)
}

/**
 * Tier 655 — the Ertragsanteil, § 22 Nr. 1 Satz 3 Buchst. a Doppelbuchst. bb
 * EStG, by the age completed when the annuity began (same source). It was a
 * flat 50 %, which is the share of someone aged 19 or 20; at 65 it is 18 %.
 */
const ERTRAGSANTEIL: Array<[number, number]> = [
  [1, 59], [3, 58], [5, 57], [8, 56], [10, 55], [12, 54], [14, 53], [16, 52], [18, 51], [20, 50],
  [22, 49], [24, 48], [26, 47], [27, 46], [29, 45], [31, 44], [32, 43], [34, 42], [35, 41], [37, 40],
  [38, 39], [40, 38], [41, 37], [42, 36], [44, 35], [45, 34], [47, 33], [48, 32], [49, 31], [50, 30],
  [52, 29], [53, 28], [54, 27], [56, 26], [57, 25], [58, 24], [59, 23], [61, 22], [62, 21], [63, 20],
  [64, 19], [66, 18], [67, 17], [68, 16], [70, 15], [71, 14], [73, 13], [74, 12], [75, 11], [77, 10],
  [79, 9], [80, 8], [82, 7], [84, 6], [87, 5], [91, 4], [93, 3], [96, 2],
]
export function ertragsanteil(alter: number): number {
  for (const [bis, pct] of ERTRAGSANTEIL) if (alter <= bis) return pct
  return 1
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class AnlageRService {
  constructor(private prisma: PrismaService) {}

  /**
   * Compute the Anlage R for the year. Returns
   * the report JSON. The controller wraps this
   * in the year-defaults + auth handling.
   *
   * v1: read the Rentenbezüge from
   * Company.settings.renten[year]. Apply
   * Besteuerungsanteil (DRV tabelle) for
   * line 100-130, Ertragsanteil (50% default)
   * for line 140. Werbungskosten are auto +
   * user-entered.
   */
  async compute(companyId: string, year: number): Promise<AnlageRResult> {
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

    // Rentenbezüge: per-year map inside
    // Company.settings.renten
    const rentenAll = (settings.renten as any) || {}
    const r = rentenAll[year] || {}
    const rentenbezuege = {
      drv: Math.max(0, Number(r.drv) || 0),
      bav: Math.max(0, Number(r.bav) || 0),
      riester: Math.max(0, Number(r.riester) || 0),
      ruerup: Math.max(0, Number(r.ruerup) || 0),
      privat: Math.max(0, Number(r.privat) || 0),
      sonstige: Math.max(0, Number(r.sonstige) || 0),
    }
    const yearOrNull = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1900 && (v as number) <= year ? (v as number) : null)
    const beginn = {
      drv: yearOrNull(r.drvBeginn),
      ruerup: yearOrNull(r.ruerupBeginn),
      sonstige: yearOrNull(r.sonstigeBeginn),
      privatAlter: Number.isInteger(r.privatAlter) && r.privatAlter >= 0 && r.privatAlter <= 120 ? (r.privatAlter as number) : null,
    }
    const hasRentenbezuege =
      rentenbezuege.drv > 0 ||
      rentenbezuege.bav > 0 ||
      rentenbezuege.riester > 0 ||
      rentenbezuege.ruerup > 0 ||
      rentenbezuege.privat > 0 ||
      rentenbezuege.sonstige > 0

    // Build einnahmen lines
    const einnahmen: AnlageRLine[] = []
    let einnahmenTotal = 0
    const kzToBetrag: Record<string, number> = {
      '100': rentenbezuege.drv,
      '110': rentenbezuege.bav,
      '120': rentenbezuege.riester,
      '130': rentenbezuege.ruerup,
      '140': rentenbezuege.privat,
      '150': rentenbezuege.sonstige,
    }
    // Tier 655: each line by its own rule. Where the start of a pension is
    // not entered, the share of a pension beginning in the tax year itself is
    // taken — the highest it can be, so the preview never shows too little.
    const de = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 1 })
    for (const def of EINNAHMEN_LINES) {
      const raw = kzToBetrag[def.kz] || 0
      let pct = 100
      let note: string | undefined
      if (def.rule === 'aa') {
        const b = beginn[def.beginn!]
        pct = besteuerungsanteil(b ?? year)
        note = b
          ? `Rentenbeginn ${b}: Besteuerungsanteil ${de(pct)} % (§ 22 Nr. 1 S. 3 a) aa) EStG). Der steuerfreie Teil ist ein fester Eurobetrag aus dem Jahr nach dem Rentenbeginn — spätere Rentenerhöhungen sind voll steuerpflichtig; hier wird vereinfacht der Anteil auf den Jahresbetrag angewendet.`
          : `Rentenbeginn nicht eingetragen — gerechnet mit dem Anteil für einen Rentenbeginn ${year} (${de(pct)} %), dem höchsten, der in Frage kommt. Bitte das Jahr des Rentenbeginns eintragen.`
      } else if (def.rule === 'bb') {
        pct = ertragsanteil(beginn.privatAlter ?? 0)
        note = beginn.privatAlter != null
          ? `Alter bei Rentenbeginn ${beginn.privatAlter}: Ertragsanteil ${pct} % (§ 22 Nr. 1 S. 3 a) bb) EStG).`
          : `Alter bei Rentenbeginn nicht eingetragen — gerechnet mit dem höchsten Ertragsanteil (${pct} %). Bitte das Alter eintragen.`
      } else {
        note = 'In voller Höhe steuerpflichtig, soweit die Beiträge gefördert oder steuerfrei waren (§ 22 Nr. 5 S. 1 EStG) — der Regelfall. Der Berater prüft Leistungen aus nicht geförderten Beiträgen.'
      }
      const taxable = round2(raw * (pct / 100))
      einnahmen.push({
        kennziffer: def.kz,
        label: def.label,
        amount: taxable,
        source: 'computed',
        gross: round2(raw),
        anteil: pct,
        ...(raw > 0 ? { note } : {}),
      })
      einnahmenTotal += taxable
    }

    // Werbungskosten (user-entered per Kz from
    // settings.werbungskosten[year], with 210
    // auto-filled at 102 EUR — the Rentner
    // Werbungskosten-Pauschbetrag)
    const wkUser = ((settings.rentenWerbungskosten || {})[year] || {}) as Record<string, number>
    const werbungskosten: AnlageRLine[] = WERBUNGSKOSTEN_LINES.map((d) => {
      const userVal = Number(wkUser[d.kz])
      const amount =
        d.kz === '210' ? 102 : Number.isFinite(userVal) ? userVal : d.amount
      return {
        kennziffer: d.kz,
        label: d.label,
        amount: round2(amount),
        source: d.kz === '210' ? 'computed' : 'placeholder',
        note: d.note,
      }
    })
    const werbungskostenTotal = werbungskosten.reduce((s, l) => s + l.amount, 0)

    // Raw Rentenbezüge total (pre-Besteuerungsanteil)
    const rentenbezuegeTotal = round2(
      rentenbezuege.drv +
        rentenbezuege.bav +
        rentenbezuege.riester +
        rentenbezuege.ruerup +
        rentenbezuege.privat +
        rentenbezuege.sonstige,
    )

    const einkuenfte = round2(einnahmenTotal - werbungskostenTotal)

    return {
      year,
      companyId,
      rentenbezuege,
      beginn,
      einnahmen,
      werbungskosten,
      totals: {
        rentenbezuegeTotal,
        // (the share of the statutory pension's line, and of the private annuity's)
        besteuerungsanteil: besteuerungsanteil(beginn.drv ?? year),
        ertragsanteil: ertragsanteil(beginn.privatAlter ?? 0),
        einnahmenTotal: round2(einnahmenTotal),
        werbungskostenTotal: round2(werbungskostenTotal),
        einkuenfte,
      },
      counts: {
        hasRentenbezuege,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihren Rentenbezügen-Daten ' +
        '(erfasst unter Buchhaltung, Anlage R) + der BMF-Tabelle der Besteuerungsanteile ' +
        'generiert. Der Besteuerungsanteil richtet sich nach dem Jahr des Rentenbeginns ' +
        '(§ 22 Nr. 1 S. 3 a) aa) EStG): 50 % bis 2005, 80 % für 2020, 84 % für 2026, 100 % ab 2058. ' +
        'Betriebs- und Riester-Renten sind in voller Höhe angesetzt (§ 22 Nr. 5 EStG), ' +
        'private Leibrenten mit dem Ertragsanteil nach dem Alter bei Rentenbeginn. ' +
        'Werbungskosten-Pauschbetrag 102 EUR (Kz 210) ist auto-berechnet. ' +
        'Anlage R ist für Einkünfte aus Renten und Bezügen (§ 22 EStG) — ' +
        'gesetzliche Rente (DRV), Betriebsrente (BAV), Riester, Rürup, ' +
        'private Leibrenten. Vor der Einreichung durch den Steuerberater prüfen ' +
        'lassen.',
    }
  }

  /**
   * Render the Anlage R as a GoBD-style A4 PDF.
   * Same layout family as the other Anlagen:
   * header + Rentenbezüge summary + 2 tables
   * (Einnahmen + Werbungskosten) + Einkünfte
   * pill + Besteuerungsanteil info box + disclaimer
   * + footer.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = flowFromLeft(new PDFDocument({ size: 'A4', margin: 40 }))
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-R-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage R ${year} — VORSCHAU`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Einkünfte aus Renten und Bezügen (§ 22 EStG) — ${company?.name || companyId}`,
      )
      .moveDown(1)

    // Rentenbezüge summary
    if (data.counts.hasRentenbezuege) {
      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('Rentenbezüge (Brutto, vor Besteuerungsanteil)')
      doc.moveDown(0.3)
      doc.fontSize(9).font('Helvetica')
      const r = data.rentenbezuege
      doc.text(`DRV (gesetzliche Rente): ${this.fmtEur(r.drv)} €`)
      doc.text(`BAV (Betriebsrente): ${this.fmtEur(r.bav)} €`)
      doc.text(`Riester-Rente: ${this.fmtEur(r.riester)} €`)
      doc.text(`Rürup-Rente: ${this.fmtEur(r.ruerup)} €`)
      doc.text(`Private Leibrenten: ${this.fmtEur(r.privat)} €`)
      doc.text(`Sonstige: ${this.fmtEur(r.sonstige)} €`)
      doc.text(`Summe Rentenbezüge: ${this.fmtEur(data.totals.rentenbezuegeTotal)} €`)
      doc.moveDown(0.5)
      doc
        .fontSize(8)
        .fillColor('#666')
        .text(
          `Gesetzliche Rente: Besteuerungsanteil ${String(data.totals.besteuerungsanteil).replace('.', ',')} % ` +
            (data.beginn.drv ? `(Rentenbeginn ${data.beginn.drv})` : '(Rentenbeginn nicht eingetragen — höchster Anteil)') +
            ', § 22 Nr. 1 S. 3 a) aa) EStG',
        )
        .text(
          `Private Leibrenten: Ertragsanteil ${data.totals.ertragsanteil} % ` +
            (data.beginn.privatAlter != null ? `(Alter bei Rentenbeginn ${data.beginn.privatAlter})` : '(Alter bei Rentenbeginn nicht eingetragen — höchster Anteil)') +
            ', § 22 Nr. 1 S. 3 a) bb) EStG',
        )
        .fillColor('#000')
      doc.moveDown(1)
    } else {
      doc
        .fontSize(10)
        .font('Helvetica-Oblique')
        .fillColor('#b45309')
        .text(
          '⚠ Keine Rentenbezüge für dieses Jahr erfasst. ' +
            'Die Anlage R ist ohne Rentenbezüge leer — bitte auf der ' +
            'Seite Buchhaltung nachpflegen.',
        )
        .fillColor('#000')
      doc.moveDown(1)
    }

    // Einnahmen
    doc.fontSize(12).font('Helvetica-Bold').text('Besteuerungsanteil pro Kz')
    doc.moveDown(0.3)
    this.renderTable(doc, data.einnahmen, data.totals.einnahmenTotal, 'Steuerbare Einkünfte')
    doc.moveDown(0.8)

    // Werbungskosten
    doc.fontSize(12).font('Helvetica-Bold').text('Werbungskosten')
    doc.moveDown(0.3)
    this.renderTable(
      doc,
      data.werbungskosten,
      data.totals.werbungskostenTotal,
      'Werbungskosten',
    )
    doc.moveDown(1)

    // Einkünfte pill
    doc.fontSize(13).font('Helvetica-Bold')
    const e = data.totals.einkuenfte
    doc
      .fillColor(e >= 0 ? '#b91c1c' : '#047857')
      .text(
        e >= 0
          ? `Einkünfte aus Renten und Bezügen: ${this.fmtEur(e)} €`
          : `Verlust: ${this.fmtEur(Math.abs(e))} € (negative Einkünfte sind steuerlich ein Vorteil — die Werbungskosten übersteigen die besteuerten Rentenbezüge)`,
      )
      .fillColor('#000')
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
          `de-invoice · Anlage R Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: AnlageRLine[],
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
