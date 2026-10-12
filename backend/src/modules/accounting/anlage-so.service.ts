import { freigrenzeFor, fristYears, kindOf, statusOf, vgSummary, VgKind } from './anlage-so-rules'
import { flowFromLeft } from '../../common/pdf-flow'
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
  type: VgKind // Tier 664: krypto | sonstige | grundstueck | wertpapier
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
    countKrypto: number
    countGrundstueck: number
    /** Tier 664: securities bought since 2009 — capital income, not on this form */
    countKap: number
    gainKap: number
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
// Tier 656: the limit depends on the year — anlage-so-rules.ts

const LINES: Array<{
  kz: string
  label: string
  source: 'computed' | 'placeholder'
  note?: string
}> = [
  // Tier 664: the kinds and periods of § 23 Abs. 1 (anlage-so-rules.ts)
  {
    kz: '32',
    label:
      'Wertpapiere, vor 2009 angeschafft (§ 23 Abs. 1 Nr. 2 EStG a. F.) — seit 2009 angeschaffte gehören in die Anlage KAP',
    source: 'computed',
  },
  {
    kz: '34',
    label:
      'Veräußerung von Kryptowerten / Token (§ 23 Abs. 1 Nr. 2 EStG) — Frist ein Jahr',
    source: 'computed',
  },
  {
    kz: '41',
    label:
      'Veräußerung anderer Wirtschaftsgüter (§ 23 Abs. 1 Nr. 2 EStG) — Gold, Kunst, Schmuck, Uhren, Antiquitäten etc., Frist ein Jahr',
    source: 'computed',
  },
  {
    kz: '43',
    label:
      'Veräußerung von Grundstücken / Immobilien im Privatvermögen (§ 23 Abs. 1 Nr. 1 EStG) — Frist zehn Jahre',
    source: 'computed',
    note:
      'Ausgenommen ist das selbst bewohnte Haus (§ 23 Abs. 1 Nr. 1 Satz 3 EStG) — der Berater prüft das.',
  },
  // Kz 20: Freigrenze
  {
    kz: '20',
    label:
      'Freigrenze für private Veräußerungsgeschäfte (§ 23 Abs. 3 Satz 5 EStG): unter 1.000 EUR Gesamtgewinn im Jahr steuerfrei (bis 2023: 600 EUR), ab der Grenze in voller Höhe steuerpflichtig.',
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
        // Tier 664: the kind (a row from before knows two, with crypto filed
        // as a security — kindOf reads the description then)
        const type = kindOf({ type: t.type, description: t.description })
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

    // Tier 664: by the rules of § 23 — each sale by its kind's period, the
    // year's losses set off against its gains, the Freigrenze on what is left.
    const sum = vgSummary(transactions, year)
    const priv = transactions.filter((t) => statusOf(t) !== 'kap')
    const totalGain = priv.reduce((s, t) => s + Math.max(t.salePrice - t.acquisitionCost, 0), 0)
    const totalLoss = priv.reduce((s, t) => s + Math.min(t.salePrice - t.acquisitionCost, 0), 0)
    const taxableGain = sum.net
    const inSpekulationsfrist = sum.countTaxable
    const vgTotal = sum.taxable

    // Build the BMF Vordruck Kz lines
    const lines: AnlageSOLine[] = LINES.map((d) => {
      let amount = 0
      if (d.kz === '32') amount = sum.gainByKind.wertpapier
      else if (d.kz === '34') amount = sum.gainByKind.krypto
      else if (d.kz === '41') amount = sum.gainByKind.sonstige
      else if (d.kz === '43') amount = sum.gainByKind.grundstueck
      else if (d.kz === '20') {
        // the limit of the year — 0 when nothing was sold within its period
        amount = sum.countTaxable > 0 ? freigrenzeFor(year) : 0
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
      if (d.kz === '32' && sum.countKap > 0) {
        line.note = `${sum.countKap} Geschäft(e) mit seit 2009 angeschafften Wertpapieren sind hier nicht angesetzt — ihr Ergebnis (${this.fmtEur(sum.gainKap)} €) ist Kapitalertrag (§ 20 Abs. 2 EStG, Anlage KAP), unabhängig von der Haltedauer.`
      }
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
        countWertpapier: sum.countByKind.wertpapier,
        countSonstige: sum.countByKind.sonstige,
        countKrypto: sum.countByKind.krypto,
        countGrundstueck: sum.countByKind.grundstueck,
        countKap: sum.countKap,
        gainKap: sum.gainKap,
        totalGain: round2(totalGain),
        totalLoss: round2(totalLoss),
        taxableGain: round2(taxableGain),
        inSpekulationsfrist,
      },
      freigrenze: freigrenzeFor(year),
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
        '(erfasst unter Buchhaltung, Anlage SO) generiert. ' +
        'Private Veräußerungsgeschäfte (§ 23 Abs. 1 EStG): Grundstücke sind zehn Jahre ' +
        'nach der Anschaffung steuerverstrickt (Nr. 1), andere Wirtschaftsgüter — Gold, ' +
        'Kunst, Kryptowerte — ein Jahr (Nr. 2). Wertpapiere, die seit 2009 angeschafft ' +
        'wurden, gehören nicht hierher: ihr Veräußerungsergebnis ist Kapitalertrag ' +
        '(§ 20 Abs. 2 EStG, Anlage KAP) und wird hier nicht angesetzt. ' +
        'Verluste des Jahres werden mit seinen Gewinnen verrechnet (§ 23 Abs. 3 Satz 7 EStG). ' +
        'Freigrenze: bleibt der Gesamtgewinn des Jahres unter 1.000 EUR (bis 2023: 600 EUR), ist er steuerfrei; ' +
        'ab der Grenze ist er in voller Höhe steuerpflichtig ' +
        '(§ 23 Abs. 3 Satz 5 EStG). Veräußerungen nach Ablauf der Frist sind steuerfrei. ' +
        'Nicht berücksichtigt: das selbst bewohnte Haus, die auf zehn Jahre verlängerte Frist ' +
        'für Wirtschaftsgüter, die als Einkunftsquelle genutzt wurden, ein Verlustrücktrag — der Berater prüft das. ' +
        'Werbungskosten-Pauschbetrag bei wiederkehrenden ' +
        'Bezügen: 102 EUR/Jahr (gesetzliche Renten) bzw. ' +
        'tatsächliche Werbungskosten. BMF-Sätze ändern sich ' +
        'jährlich; hier sind die Sätze von 2024 hinterlegt.',
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

    const doc = flowFromLeft(new PDFDocument({ size: 'A4', margin: 40 }))
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
        const status = statusOf(t)
        const frist = fristYears(t.type)
        const KIND: Record<string, string> = { wertpapier: 'Wertpapier', krypto: 'Kryptowert', sonstige: 'Sonstiges', grundstueck: 'Grundstück' }
        doc.text(
          `• [${KIND[t.type] || t.type}] ` +
            `${t.description || '(ohne Beschreibung)'} — ` +
            `Anschaffung ${t.acquisitionDate} (${this.fmtEur(t.acquisitionCost)} €) → ` +
            `Verkauf ${t.saleDate} (${this.fmtEur(t.salePrice)} €) = ` +
            `${this.fmtEur(gain)} € ${gain >= 0 ? 'Gewinn' : 'Verlust'} ` +
            (status === 'kap'
              ? '[seit 2009 angeschafft — Anlage KAP, hier nicht angesetzt]'
              : `[gehalten: ${held.toFixed(2)} Jahre, Frist: ${frist} J., ${status === 'steuerpflichtig' ? 'in Frist' : 'außerhalb'}]`),
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
