import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 109: Anlage SO — Sonstige Einkünfte
 * (§ 22 EStG).
 *
 * The 8th Anlage form (after S / V / KAP / G / N /
 * R / Kind). Catch-all for Einkünfte that don't
 * fit the other Anlagen.
 *
 * § 22 EStG enumerates the categories:
 *   - Nr. 1: Wiederkehrende Bezüge (private
 *     pensions, Unterhaltsleistungen)
 *   - Nr. 2: Einkünfte aus privaten
 *     Veräußerungsgeschäften (sales of
 *     crypto / gold / art / etc. within
 *     Spekulationsfrist)
 *   - Nr. 3: Einkünfte aus Leistungen
 *     (Abgeordnetenbezüge, compensation)
 *   - Nr. 4: Beteiligungen an Personengesellschaften
 *     (when not gewerblich)
 *   - Nr. 5: Altersvorsorgeverträge (Riester-Rente)
 *   - Nr. 6: Einkünfte aus privaten Darlehen
 *
 * v1 focuses on the most common categories:
 *   (a) Private Veräußerungsgeschäfte — sales of
 *       Wertpapiere (1-year Spekulationsfrist, § 23
 *       Abs. 1 Nr. 2 EStG) and Sonstige Wirtschaftsgüter
 *       (10-year Spekulationsfrist, § 23 Abs. 1 Nr. 1
 *       EStG) — crypto, gold, art, watches, etc.
 *   (b) Wiederkehrende Bezüge — total amount of
 *       private pensions / Unterhaltsleistungen +
 *       Werbungskosten.
 *
 * The BMF Vordruck Anlage SO 2024 uses these
 * Kennziffern (v1 internal namespace, the actual
 * Hauptvordruck uses 100+):
 *   - Kz 32-37: Veräußerung Wertpapiere (1-Jahr)
 *   - Kz 41-44: Veräußerung Sonstige WG (10-Jahr)
 *   - Kz 11-16: Wiederkehrende Bezüge
 *   - Kz 20: Freigrenze 600 EUR (§ 23 Abs. 3 EStG)
 *
 * v1 data model: Company.settings.anlageSO[year] = {
 *   transactions: Array<{ type, description,
 *     acquisitionDate, acquisitionCost, saleDate,
 *     salePrice }>,
 *   wiederkehrendeBezuege: number,
 *   werbungskosten: number,
 * }
 *
 * The opt-in flag `Company.settings.anlageSo === true`
 * gates whether the report is generated. v1 also
 * auto-detects entries in the year (length of
 * transactions > 0 or wiederkehrendeBezuege > 0).
 */
export interface VgTransaction {
  type: 'wertpapier' | 'sonstige'
  description: string
  acquisitionDate: string // ISO date
  acquisitionCost: number
  saleDate: string // ISO date
  salePrice: number
}

export interface AnlageSOLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

export interface AnlageSOResult {
  year: number
  companyId: string
  transactions: VgTransaction[]
  wiederkehrendeBezuege: number
  werbungskosten: number
  // Computed per-transaction
  vg: {
    count: number
    countWertpapier: number
    countSonstige: number
    totalGain: number
    totalLoss: number
    taxableGain: number // after Spekulationsfrist check
    inSpekulationsfrist: number // count within Frist
  }
  freigrenze: number // 600 EUR
  lines: AnlageSOLine[]
  totals: {
    vgTotal: number // taxable gains after Freigrenze
    wiederkehrendeBezuegeTotal: number
    werbungskostenTotal: number
    einkuenfte: number // final taxable
  }
  counts: {
    hasVg: boolean
    hasWiederkehrende: boolean
  }
  generatedAt: string
  disclaimer: string
}

// Standard-Freigrenze für private Veräußerungsgeschäfte
// (§ 23 Abs. 3 Satz 5 EStG): 600 EUR/Jahr. v1: hard-coded
// 2024 figure. v2: per-year BMF table.
const FREIGRENZE_2024 = 600

// Spekulationsfrist per type (in years). § 23 Abs. 1
// EStG: 1 year for Wertpapiere (Nr. 2), 10 years for
// Sonstige Wirtschaftsgüter (Nr. 1).
const SPEKULATIONSFRIST_YEARS: Record<string, number> = {
  wertpapier: 1,
  sonstige: 10,
}

const LINES: Array<{
  kz: string
  label: string
  source: 'computed' | 'placeholder'
  note?: string
}> = [
  // Kz 32-37: Veräußerung Wertpapiere
  {
    kz: '32',
    label:
      'Veräußerung von Wertpapieren (§ 23 Abs. 1 Nr. 2 EStG) innerhalb der 1-Jahres-Spekulationsfrist',
    source: 'computed',
  },
  {
    kz: '34',
    label:
      'Veräußerung von Kryptowährungen / Token (§ 23 Abs. 1 Nr. 2 EStG) — 1-Jahres-Spekulationsfrist',
    source: 'computed',
  },
  // Kz 41-44: Veräußerung Sonstige WG
  {
    kz: '41',
    label:
      'Veräußerung von sonstigen Wirtschaftsgütern (§ 23 Abs. 1 Nr. 1 EStG) — Gold, Kunst, Schmuck, Uhren, Antiquitäten etc., 10-Jahres-Spekulationsfrist',
    source: 'computed',
  },
  {
    kz: '43',
    label:
      'Veräußerung von Grundstücken / Immobilien im Privatvermögen (§ 23 Abs. 1 Nr. 1 EStG)',
    source: 'placeholder',
    note:
      'Bei Immobilien greift die 10-Jahres-Spekulationsfrist. v1: Berater ergänzt manuell. v2: Erfassung wie bei Wertpapieren.',
  },
  // Kz 20: Freigrenze
  {
    kz: '20',
    label:
      'Freigrenze für private Veräußerungsgeschäfte (§ 23 Abs. 3 Satz 5 EStG) — 600 EUR/Jahr. Bis zu diesem Betrag steuerfrei.',
    source: 'computed',
  },
  // Kz 11-16: Wiederkehrende Bezüge
  {
    kz: '11',
    label:
      'Wiederkehrende Bezüge (§ 22 Nr. 1 EStG) — private Pensionen, Versorgungsleistungen, Unterhaltsleistungen',
    source: 'computed',
  },
  {
    kz: '12',
    label:
      'Werbungskosten-Pauschbetrag bei wiederkehrenden Bezügen — 102 EUR (Renten aus gesetzlichen Rentenversicherungen) bzw. tatsächliche Werbungskosten',
    source: 'computed',
  },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Compute the holding period in years (floating point)
 * between two ISO dates. Used for the Spekulationsfrist
 * check (§ 23 Abs. 1 EStG).
 */
function yearsBetween(startISO: string, endISO: string): number {
  const a = new Date(startISO)
  const b = new Date(endISO)
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0
  const ms = b.getTime() - a.getTime()
  return ms / (365.25 * 24 * 60 * 60 * 1000)
}

@Injectable()
export class AnlageSOService {
  constructor(private prisma: PrismaService) {}

  /**
   * Compute the Anlage SO for the year. Returns
   * the report JSON. The controller wraps this
   * in the year-defaults + auth handling.
   */
  async compute(companyId: string, year: number): Promise<AnlageSOResult> {
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
    const anlageSoAll = (settings.anlageSO as any) || {}
    const yearData = anlageSoAll[year] || {}

    // Normalize transactions
    const rawTx = Array.isArray(yearData.transactions) ? yearData.transactions : []
    const transactions: VgTransaction[] = rawTx
      .filter((t: any) => t && typeof t === 'object')
      .map((t: any) => {
        const type: 'wertpapier' | 'sonstige' =
          t.type === 'wertpapier' ? 'wertpapier' : 'sonstige'
        return {
          type,
          description: String(t.description || '').trim(),
          acquisitionDate:
            typeof t.acquisitionDate === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(t.acquisitionDate)
              ? t.acquisitionDate
              : '',
          acquisitionCost: Number(t.acquisitionCost) || 0,
          saleDate:
            typeof t.saleDate === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(t.saleDate)
              ? t.saleDate
              : '',
          salePrice: Number(t.salePrice) || 0,
        }
      })
      // Only include transactions that actually sold in `year`
      .filter((t: VgTransaction) => {
        if (!t.saleDate) return false
        return Number(t.saleDate.slice(0, 4)) === year
      })

    const wiederkehrendeBezuege = Number(yearData.wiederkehrendeBezuege) || 0
    const werbungskosten = Number(yearData.werbungskosten) || 0

    // Per-transaction gain + Spekulationsfrist check
    const countWertpapier = transactions.filter((t) => t.type === 'wertpapier').length
    const countSonstige = transactions.filter((t) => t.type === 'sonstige').length
    let totalGain = 0
    let totalLoss = 0
    let taxableGain = 0
    let inSpekulationsfrist = 0
    for (const t of transactions) {
      const gain = t.salePrice - t.acquisitionCost
      if (gain > 0) totalGain += gain
      else totalLoss += gain // negative
      // Spekulationsfrist: only count if within the Frist
      const fristYears = SPEKULATIONSFRIST_YEARS[t.type] ?? 10
      const held = yearsBetween(t.acquisitionDate, t.saleDate)
      if (held < fristYears) {
        inSpekulationsfrist += 1
        if (gain > 0) taxableGain += gain
      } else {
        // Outside Spekulationsfrist: not taxable. Don't
        // include in the taxable sum (don't subtract losses
        // from in-Frist gains — v1 keeps the simple model).
      }
    }

    // Freigrenze 600 EUR: if total taxable gains <= 600,
    // the whole thing is tax-free. v1: only positive
    // gains count toward the Freigrenze (losses don't
    // reduce the Freigrenze).
    const vgTotal =
      taxableGain > 0 && taxableGain <= FREIGRENZE_2024
        ? 0
        : Math.max(taxableGain - FREIGRENZE_2024, 0)

    // Build the BMF Vordruck Kz lines
    const lines: AnlageSOLine[] = LINES.map((d) => {
      let amount = 0
      if (d.kz === '32' || d.kz === '34') {
        // Wertpapier / Krypto total taxable gain
        amount = round2(
          transactions
            .filter(
              (t) =>
                t.type === 'wertpapier' &&
                yearsBetween(t.acquisitionDate, t.saleDate) <
                  (SPEKULATIONSFRIST_YEARS.wertpapier ?? 1),
            )
            .reduce((s, t) => s + Math.max(t.salePrice - t.acquisitionCost, 0), 0),
        )
      } else if (d.kz === '41') {
        // Sonstige WG total taxable gain
        amount = round2(
          transactions
            .filter(
              (t) =>
                t.type === 'sonstige' &&
                yearsBetween(t.acquisitionDate, t.saleDate) <
                  (SPEKULATIONSFRIST_YEARS.sonstige ?? 10),
            )
            .reduce((s, t) => s + Math.max(t.salePrice - t.acquisitionCost, 0), 0),
        )
      } else if (d.kz === '20') {
        // Freigrenze: 600 (or 0 if no gains)
        amount = taxableGain > 0 ? FREIGRENZE_2024 : 0
      } else if (d.kz === '11') {
        amount = round2(wiederkehrendeBezuege)
      } else if (d.kz === '12') {
        amount = round2(werbungskosten)
      }
      const line: AnlageSOLine = {
        kennziffer: d.kz,
        label: d.label,
        amount,
        source: d.source,
      }
      if (d.note) line.note = d.note
      return line
    })

    const einkuenfte = round2(
      vgTotal + wiederkehrendeBezuege - werbungskosten,
    )

    return {
      year,
      companyId,
      transactions,
      wiederkehrendeBezuege,
      werbungskosten,
      vg: {
        count: transactions.length,
        countWertpapier,
        countSonstige,
        totalGain: round2(totalGain),
        totalLoss: round2(totalLoss),
        taxableGain: round2(taxableGain),
        inSpekulationsfrist,
      },
      freigrenze: FREIGRENZE_2024,
      lines,
      totals: {
        vgTotal: round2(vgTotal),
        wiederkehrendeBezuegeTotal: round2(wiederkehrendeBezuege),
        werbungskostenTotal: round2(werbungskosten),
        einkuenfte,
      },
      counts: {
        hasVg: transactions.length > 0,
        hasWiederkehrende: wiederkehrendeBezuege > 0,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihren privaten ' +
        'Veräußerungsgeschäften und wiederkehrenden Bezügen ' +
        '(Company.settings.anlageSO[year]) generiert. ' +
        'Spekulationsfrist: 1 Jahr für Wertpapiere (§ 23 Abs. 1 ' +
        'Nr. 2 EStG), 10 Jahre für sonstige Wirtschaftsgüter ' +
        '(§ 23 Abs. 1 Nr. 1 EStG). Freigrenze: 600 EUR/Jahr ' +
        '(§ 23 Abs. 3 Satz 5 EStG). Veräußerungen außerhalb der ' +
        'Spekulationsfrist sind steuerfrei. Verluste aus ' +
        'Veräußerungen innerhalb der Frist können v1 nicht ' +
        'mit Gewinnen verrechnet werden (BMF: nur in ' +
        'Sonderfällen). v2: vollständige Verlustverrechnung. ' +
        'Werbungskosten-Pauschbetrag bei wiederkehrenden ' +
        'Bezügen: 102 EUR/Jahr (gesetzliche Renten) bzw. ' +
        'tatsächliche Werbungskosten. BMF-Sätze ändern sich ' +
        'jährlich; v1 verwendet 2024-Sätze als Default. v2: ' +
        'BMF-Tabelle pro Jahr. Für Grundstücksveräußerungen ' +
        '(Kz 43): Spezialfall, bitte direkt im Hauptvordruck ' +
        'Anlage V eintragen.',
    }
  }

  /**
   * Render the Anlage SO as a GoBD-style A4 PDF.
   * Same layout family as the other Anlagen:
   * header + transactions list + BMF Vordruck table
   * + summary + disclaimer + footer.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-SO-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage SO ${year} — VORSCHAU`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Sonstige Einkünfte (§ 22 EStG) — ${company?.name || companyId}`,
      )
      .moveDown(1)

    // Empty-state hint
    if (!data.counts.hasVg && !data.counts.hasWiederkehrende) {
      doc
        .fontSize(10)
        .font('Helvetica-Oblique')
        .fillColor('#b45309')
        .text(
          '⚠ Keine privaten Veräußerungsgeschäfte oder ' +
            'wiederkehrenden Bezüge für dieses Jahr erfasst. ' +
            'Tragen Sie unten Ihre Veräußerungen (Krypto, ' +
            'Gold, Aktien, etc.) und / oder wiederkehrenden ' +
            'Bezüge (private Pensionen, Unterhalt) ein.',
        )
        .fillColor('#000')
      doc.moveDown(1)
    }

    // Transactions list
    if (data.transactions.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Private Veräußerungsgeschäfte (§ 23 EStG)')
      doc.moveDown(0.3)
      doc.fontSize(8).font('Helvetica')
      for (const t of data.transactions) {
        const gain = t.salePrice - t.acquisitionCost
        const held = yearsBetween(t.acquisitionDate, t.saleDate)
        const fristYears = SPEKULATIONSFRIST_YEARS[t.type] ?? 10
        const inFrist = held < fristYears
        doc.text(
          `• [${t.type === 'wertpapier' ? 'Wertpapier' : 'Sonstige'}] ` +
            `${t.description || '(ohne Beschreibung)'} — ` +
            `Anschaffung ${t.acquisitionDate} (${this.fmtEur(t.acquisitionCost)} €) → ` +
            `Verkauf ${t.saleDate} (${this.fmtEur(t.salePrice)} €) = ` +
            `${this.fmtEur(gain)} € ${gain >= 0 ? 'Gewinn' : 'Verlust'} ` +
            `[gehalten: ${held.toFixed(2)} Jahre, Frist: ${fristYears} J., ${inFrist ? 'in Frist' : 'außerhalb'}]`,
        )
      }
      doc.moveDown(1)
    }

    // Wiederkehrende Bezüge
    if (data.wiederkehrendeBezuege > 0 || data.werbungskosten > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Wiederkehrende Bezüge (§ 22 Nr. 1 EStG)')
      doc.moveDown(0.3)
      doc.fontSize(9).font('Helvetica')
      doc.text(`• Bezüge: ${this.fmtEur(data.wiederkehrendeBezuege)} €`)
      doc.text(`• Werbungskosten: ${this.fmtEur(data.werbungskosten)} €`)
      doc.moveDown(1)
    }

    // BMF Vordruck table
    doc.fontSize(12).font('Helvetica-Bold').text('BMF Vordruck Anlage SO 2024 — Kennziffern')
    doc.moveDown(0.3)
    this.renderTable(doc, data.lines, data.totals, data.freigrenze)
    doc.moveDown(1)

    // Summary
    doc.fontSize(13).font('Helvetica-Bold')
    doc.text(
      `Σ Einkünfte (§ 22 EStG): ${this.fmtEur(data.totals.einkuenfte)} €`,
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
          `de-invoice · Anlage SO Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: AnlageSOLine[],
    totals: AnlageSOResult['totals'],
    _freigrenze: number,
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
    doc.text('Einkünfte nach Berücksichtigung der Freigrenze', colKz + 35, doc.y, {
      width: 320,
    })
    doc.text(this.fmtEur(totals.einkuenfte), colAmount, doc.y, {
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
