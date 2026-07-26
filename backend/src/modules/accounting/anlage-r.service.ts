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
const EINNAHMEN_LINES: Array<{
  kz: string
  label: string
  besteuerungsanteil: 'drv' | 'privat' | 'ertragsanteil'
}> = [
  {
    kz: '100',
    label: 'Leibrenten aus der gesetzlichen Rentenversicherung (DRV, DRV-Bescheid)',
    besteuerungsanteil: 'drv',
  },
  {
    kz: '110',
    label: 'Betriebsrenten (BAV, Pensionskasse, Direktversicherung)',
    besteuerungsanteil: 'drv',
  },
  {
    kz: '120',
    label: 'Riester-Renten (reguläre Besteuerung in der Auszahlungsphase)',
    besteuerungsanteil: 'drv',
  },
  {
    kz: '130',
    label: 'Rürup-Renten / Basis-Renten (Leibrenten aus privater Altersvorsorge)',
    besteuerungsanteil: 'drv',
  },
  {
    kz: '140',
    label: 'Private Leibrenten (z.B. private Rentenversicherung — Ertragsanteil nach Alter bei Rentenbeginn)',
    besteuerungsanteil: 'privat',
  },
  {
    kz: '150',
    label: 'Sonstige Rentenbezüge (Unfallrenten, Witwen-/Waisenrente, etc.)',
    besteuerungsanteil: 'drv',
  },
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

// Besteuerungsanteil for DRV + BAV + Riester + Rürup + Sonstige:
// Tabelle nach § 22 Nr. 1 S. 3 lit. a Doppelbuchst. aa EStG
// (year → %). v1: 2005-2040+. v2: dynamically lookup BMF table.
const BESTEUERUNGSANTEIL_TABLE: Record<number, number> = {
  2005: 0.50,
  2006: 0.52,
  2007: 0.54,
  2008: 0.56,
  2009: 0.58,
  2010: 0.60,
  2011: 0.62,
  2012: 0.64,
  2013: 0.66,
  2014: 0.68,
  2015: 0.70,
  2016: 0.72,
  2017: 0.74,
  2018: 0.76,
  2019: 0.78,
  2020: 0.80,
  2021: 0.81,
  2022: 0.82,
  2023: 0.82,
  2024: 0.83,
  2025: 0.82,
  2026: 0.81, // Current year
  2027: 0.80,
  2028: 0.79,
  2029: 0.78,
  2030: 0.77,
  2031: 0.76,
  2032: 0.75,
  2033: 0.74,
  2034: 0.73,
  2035: 0.72,
  2036: 0.71,
  2037: 0.70,
  2038: 0.69,
  2039: 0.68,
  2040: 0.67,
  2041: 0.66,
  2042: 0.65,
  2043: 0.64,
  2044: 0.63,
  2045: 0.62,
  2046: 0.61,
  2047: 0.60,
  2048: 0.59,
  2049: 0.58,
  2050: 0.57,
  2051: 0.56,
  2052: 0.55,
  2053: 0.54,
  2054: 0.53,
  2055: 0.52,
  2056: 0.51,
  2057: 0.50, // End: 50% (full deduction)
}

// Ertragsanteil for private Leibrenten (§ 22 Nr. 1
// S. 3 lit. a EStG). v1: simplified to 50% for all
// private Rente (the post-2012 default). v2: full
// BMF table by age.
const ERTRAGSANTEIL_DEFAULT = 0.50

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
    const hasRentenbezuege =
      rentenbezuege.drv > 0 ||
      rentenbezuege.bav > 0 ||
      rentenbezuege.riester > 0 ||
      rentenbezuege.ruerup > 0 ||
      rentenbezuege.privat > 0 ||
      rentenbezuege.sonstige > 0

    // Besteuerungsanteil for the year
    const besteuerungsanteil =
      BESTEUERUNGSANTEIL_TABLE[year] ?? 0.50 // default 50% for years outside table
    const ertragsanteil = ERTRAGSANTEIL_DEFAULT

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
    for (const def of EINNAHMEN_LINES) {
      const raw = kzToBetrag[def.kz] || 0
      const anteil = def.besteuerungsanteil === 'privat' ? ertragsanteil : besteuerungsanteil
      const taxable = round2(raw * anteil)
      einnahmen.push({
        kennziffer: def.kz,
        label: def.label,
        amount: taxable,
        source: 'computed',
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
      einnahmen,
      werbungskosten,
      totals: {
        rentenbezuegeTotal,
        besteuerungsanteil: round2(besteuerungsanteil * 100),
        ertragsanteil: round2(ertragsanteil * 100),
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
        '(Company.settings.renten[year]) + dem BMF-Besteuerungsanteil-Tabelle ' +
        'für das Geschäftsjahr generiert. Besteuerungsanteil: 50% (bis 2040) bis ' +
        '83% (2024) — fällt jährlich um 1 Prozentpunkt bis 50% in 2057. ' +
        'Werbungskosten-Pauschbetrag 102 EUR (Kz 210) ist auto-berechnet. ' +
        'Anlage R ist für Einkünfte aus Renten und Bezügen (§ 22 EStG) — ' +
        'gesetzliche Rente (DRV), Betriebsrente (BAV), Riester, Rürup, ' +
        'private Leibrenten. Vor der Einreichung durch den Steuerberater prüfen ' +
        'lassen. v2: full BMF Ertragsanteil-Tabelle by age + multi-rente ' +
        'Ehepartner support.',
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

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
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
          `Besteuerungsanteil ${data.totals.besteuerungsanteil.toFixed(0).replace('.', ',')} % (§ 22 Nr. 1 S. 3 lit. a EStG, BMF-Tabelle)`,
        )
        .text(
          `Ertragsanteil private Leibrenten ${data.totals.ertragsanteil.toFixed(0).replace('.', ',')} % (v1: vereinfacht — v2: BMF-Tabelle nach Alter bei Rentenbeginn)`,
        )
        .fillColor('#000')
      doc.moveDown(1)
    } else {
      doc
        .fontSize(10)
        .font('Helvetica-Oblique')
        .fillColor('#b45309')
        .text(
          '⚠ Keine Rentenbezüge für dieses Jahr in Company.settings erfasst. ' +
            'Die Anlage R ist ohne Rentenbezüge leer — bitte unter ' +
            '/dashboard/accounting nachpflegen.',
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
