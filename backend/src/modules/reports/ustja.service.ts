import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { UstvaService } from './ustva.service'
import PDFDocument from 'pdfkit'

/**
 * Tier 105: UStJA — Umsatzsteuerjahreserklärung
 * (§ 18 Abs. 3 UStG, BMF Vordruck UStJA 2024).
 *
 * The annual USt return that consolidates the 12
 * monthly UStVA filings (Jan–Dez) for the calendar
 * year. This is the form the Mandant actually files
 * with the Finanzamt — the 12 UStVAs are Voraus-
 * zahlungen on the same liability, and UStJA is the
 * year-end settlement.
 *
 * v1 architecture: the service DELEGATES the
 * per-month computation to UstvaService.compute()
 * (12 calls, one per month) and sums the 12
 * sub-results. The per-month UStVA logic
 * (Bemessungsgrundlagen, igL, igE, Vorsteuer,
 * Differenzbetrag) is unchanged — we just aggregate
 * 12 monthly results into the annual Vordruck
 * fields below. This is the same data path the
 * user sees on /dashboard/accounting/ustva (the
 * monthly view); UStJA is the year view.
 *
 * BMF Vordruck UStJA 2024 — Kennziffern we expose:
 *   Kz 20-23 — Besteuerungsgrundlagen by rate (19/7)
 *   Kz 26-29 — Steuerfreie Umsätze (igL, Ausfuhren, sonstige)
 *   Kz 36 — Reverse-Charge (§ 13b UStG)
 *   Kz 66 — Summe Umsatzsteuer (Bemessungsgrundlage × Satz)
 *   Kz 67 — Summe Vorsteuer
 *   Kz 39 — Sondervorauszahlung (1/11 der Jan-UStVA)
 *   Kz 68 — Verbleibender Betrag (Zahllast, Kz 66 - Kz 67)
 *   Kz 69 — Restzahlung (Kz 68 - Kz 39)
 *   Kz 81 — Differenzbetrag (= Kz 68; redundant but
 *           listed for consistency with UStVA)
 */
export interface UstjaLine {
  kennziffer: string
  label: string
  net?: number
  vat?: number
  amount?: number // pre-computed single value (Kz 39, 68, 69, 81)
  source?: 'computed' | 'placeholder'
  note?: string
}

export interface UstjaMonthlyRow {
  month: number
  monthLabel: string
  umsatzsteuer: number
  vorsteuer: number
  zahllast: number
}

export interface UstjaResult {
  year: number
  companyId: string
  periodLabel: string
  lines: UstjaLine[]
  totals: {
    umsatzsteuer: number // Kz 66
    vorsteuer: number // Kz 67
    sondervorauszahlung: number // Kz 39
    zahllast: number // Kz 68 (66 - 67)
    restzahlung: number // Kz 69 (68 - 39)
    differenzbetrag: number // Kz 81 (same as 68)
  }
  monthlyBreakdown: UstjaMonthlyRow[]
  counts: {
    hasData: boolean
    monthsWithData: number
  }
  generatedAt: string
  disclaimer: string
}

const MONTH_LABELS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class UstjaService {
  constructor(
    private prisma: PrismaService,
    private ustva: UstvaService,
  ) {}

  /**
   * Compute the UStJA for the year. Returns the full
   * Vorschau JSON. The controller wraps this with
   * year-defaults + auth handling.
   */
  async compute(companyId: string, year: number): Promise<UstjaResult> {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    // Aggregate 12 monthly UStVAs by delegating to
    // the existing UstvaService. Each monthly call
    // returns the same shape (salesByRate, vorsteuer,
    // differenzbetrag, etc.) we already expose on
    // /api/v1/reports/ustva/compute.
    const monthlyResults = await Promise.all(
      MONTH_LABELS.map((_, idx) =>
        this.ustva
          .compute(companyId, year, undefined, idx + 1)
          .catch((e) => {
            // Defensive: never let one bad month
            // crash the year aggregation. Fall back
            // to a zero-filled month so the totals
            // still compute.
            console.warn(
              `UStJA ${year}/${idx + 1} compute failed:`,
              (e as Error).message,
            )
            return null
          }),
      ),
    )

    // ── Aggregate ──────────────────────────────────
    const lines: UstjaLine[] = []
    const monthlyBreakdown: UstjaMonthlyRow[] = []

    // Bemessungsgrundlagen by rate (Kz 20-23)
    const rateAgg = new Map<number, { net: number; vat: number; label: string }>()
    // Exempts (Kz 26-29)
    let igL = 0
    let exportThird = 0
    let otherExempt = 0
    // Reverse charge (Kz 36)
    let reverseCharge = 0
    // Vorsteuer (Kz 56-66)
    let vorsteuer19 = 0
    let vorsteuer7 = 0
    let vorsteuerIgE = 0
    let vorsteuerReverseCharge = 0
    // Differenzbetrag (Kz 81) per month
    let umsatzsteuerTotal = 0 // Kz 66
    let vorsteuerTotal = 0 // Kz 67

    let monthsWithData = 0
    for (let i = 0; i < monthlyResults.length; i++) {
      const m = monthlyResults[i]
      if (!m) {
        monthlyBreakdown.push({
          month: i + 1,
          monthLabel: MONTH_LABELS[i],
          umsatzsteuer: 0,
          vorsteuer: 0,
          zahllast: 0,
        })
        continue
      }
      const hasMonthData =
        m.umsatzsteuer !== 0 || m.vorsteuerSum !== 0 || m.igL !== 0
      if (hasMonthData) monthsWithData++

      for (const s of m.salesByRate) {
        const existing = rateAgg.get(s.rate) || {
          net: 0,
          vat: 0,
          label: s.label,
        }
        existing.net += s.net
        existing.vat += s.vat
        rateAgg.set(s.rate, existing)
      }
      igL += m.igL
      exportThird += m.export
      otherExempt += m.otherExempt
      reverseCharge += m.reverseCharge
      vorsteuer19 += m.vorsteuer.from19
      vorsteuer7 += m.vorsteuer.from7
      vorsteuerIgE += m.vorsteuer.fromIgE
      vorsteuerReverseCharge += m.vorsteuer.fromReverseCharge
      umsatzsteuerTotal += m.umsatzsteuer
      vorsteuerTotal += m.vorsteuerSum

      monthlyBreakdown.push({
        month: i + 1,
        monthLabel: MONTH_LABELS[i],
        umsatzsteuer: round2(m.umsatzsteuer),
        vorsteuer: round2(m.vorsteuerSum),
        zahllast: round2(m.differenzbetrag),
      })
    }

    // ── Lines (BMF Vordruck order) ──────────────────
    // Bemessungsgrundlagen (Kz 20-23)
    // The BMF Vordruck uses these Kz:
    //   Kz 20 — 19% Umsätze
    //   Kz 21 — 7% Umsätze
    //   Kz 22 — 0% (igL, igE) — already covered
    //        by Kz 41 below
    //   Kz 23 — sonstige (übrige)
    // We detect the rate as the percentage value
    // (i.e. 19 or 7), not the decimal form (0.19
    // or 0.07) — the BMF Vordruck labels use the
    // integer percentage.
    for (const [rate, agg] of [...rateAgg.entries()].sort((a, b) => b[0] - a[0])) {
      // Normalize: if rate is 0.19 → 19; if 19 → 19
      const pct =
        Math.abs(rate) < 1 ? Math.round(rate * 100) : Math.round(rate)
      let kz = ''
      if (pct === 19) kz = '20'
      else if (pct === 7) kz = '21'
      else if (pct === 0) kz = '22'
      else kz = '23'
      lines.push({
        kennziffer: kz,
        label: `Steuerpflichtige Umsätze ${pct}% (§ 12 Abs. 1 UStG)`,
        net: round2(agg.net),
        vat: round2(agg.vat),
        source: 'computed',
      })
    }

    // Steuerfreie Umsätze (Kz 26-29)
    if (igL !== 0 || exportThird !== 0 || otherExempt !== 0) {
      lines.push({
        kennziffer: '41',
        label: 'Innergemeinschaftliche Lieferungen (§ 4 Nr. 1b UStG)',
        net: round2(igL),
        amount: round2(igL),
        source: 'computed',
      })
      lines.push({
        kennziffer: '43',
        label: 'Ausfuhren (§ 4 Nr. 1a UStG, Drittland)',
        net: round2(exportThird),
        amount: round2(exportThird),
        source: 'computed',
      })
      lines.push({
        kennziffer: '44',
        label: 'Sonstige steuerfreie Umsätze',
        net: round2(otherExempt),
        amount: round2(otherExempt),
        source: 'computed',
      })
    }

    // Reverse Charge (Kz 36)
    if (reverseCharge !== 0) {
      lines.push({
        kennziffer: '36',
        label: 'Innergemeinschaftliche Erwerbe (§ 1a UStG) — Reverse Charge',
        net: round2(reverseCharge),
        vat: round2(reverseCharge * 0.19),
        source: 'computed',
      })
    }

    // ── Totals (Kz 66, 67) ──────────────────────────
    const sondervorauszahlung = round2(
      (monthlyResults[0]?.differenzbetrag || 0) / 11,
    )
    const zahllast = round2(umsatzsteuerTotal - vorsteuerTotal)
    const restzahlung = round2(zahllast - sondervorauszahlung)

    // Add the totals as summary lines (rendered in
    // a separate block by the frontend; included in
    // the lines array for completeness).
    lines.push({
      kennziffer: '66',
      label: 'Summe Umsatzsteuer (Bemessungsgrundlagen × Steuersätze)',
      amount: round2(umsatzsteuerTotal),
      source: 'computed',
    })
    lines.push({
      kennziffer: '67',
      label: 'Summe Vorsteuer (aus Eingangsrechnungen + igE + § 13b)',
      amount: round2(vorsteuerTotal),
      source: 'computed',
    })
    lines.push({
      kennziffer: '68',
      label: 'Verbleibender Betrag (Kz 66 - Kz 67) — Zahllast (positiv) / Erstattung (negativ)',
      amount: zahllast,
      source: 'computed',
    })
    lines.push({
      kennziffer: '39',
      label: 'Sondervorauszahlung (1/11 der Jan-UStVA, § 47 Abs. 1 UStDV)',
      amount: sondervorauszahlung,
      source: 'computed',
    })
    lines.push({
      kennziffer: '69',
      label: 'Restzahlung (Kz 68 - Kz 39) — bis 31.05. des Folgejahres an das Finanzamt',
      amount: restzahlung,
      source: 'computed',
    })
    lines.push({
      kennziffer: '81',
      label: 'Differenzbetrag (= Kz 68, Vordruck-Konsistenz mit UStVA)',
      amount: zahllast,
      source: 'computed',
    })

    return {
      year,
      companyId,
      periodLabel: `01.01.${year} – 31.12.${year}`,
      lines,
      totals: {
        umsatzsteuer: round2(umsatzsteuerTotal),
        vorsteuer: round2(vorsteuerTotal),
        sondervorauszahlung,
        zahllast,
        restzahlung,
        differenzbetrag: zahllast,
      },
      monthlyBreakdown,
      counts: {
        hasData: monthsWithData > 0,
        monthsWithData,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus den 12 monatlichen UStVA-Daten ' +
        `(${year}) aggregiert (§ 18 Abs. 3 UStG, BMF Vordruck UStJA 2024). ` +
        'Grundlage: alle finalisierten Rechnungen (status=paid/sent/overdue) + ' +
        'Eingangsrechnungen (status=booked/deductible) im Zeitraum. ' +
        'Bemessungsgrundlagen (Kz 20-23) und Vorsteuer (Kz 67) stammen aus den ' +
        'BMF-Vordruck-Positionen; die Sondervorauszahlung (Kz 39) wird als 1/11 der ' +
        'Januar-Differenz berechnet (§ 47 Abs. 1 UStDV). Im Festsetzungs-Bescheid ' +
        'verwendet das Finanzamt die tatsächlichen Vorauszahlungen des Mandanten ' +
        '(aus den 12 UStVA-Filings); die Differenz wird über Kz 39 + Kz 69 ' +
        'ausgeglichen. v1: vereinfachtes Modell — Berater verifiziert die ' +
        'BMF-Sätze pro Bundesland und prüft Korrekturen (z.B. § 1a / § 13b ' +
        'UStG Erwerbe, igL-Bestätigungen, EU-OSS-Sachverhalte). v2: native ' +
        'ELSTER-XML-Export für die elektronische Übermittlung.',
    }
  }

  /**
   * Render the UStJA as a GoBD-style A4 PDF.
   * Same layout family as the other Berater packager
   * PDFs: header + monthly breakdown + summary +
   * disclaimer + footer.
   */
  async renderPdf(companyId: string, year: number, res: any): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="UStJA-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Umsatzsteuerjahreserklärung ${year} — VORSCHAU`, {
        align: 'left',
      })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `UStJA gem. § 18 Abs. 3 UStG (BMF Vordruck 2024) — ${company?.name || companyId} | Zeitraum ${data.periodLabel}`,
      )
      .moveDown(1)

    // Monthly breakdown table
    doc.fontSize(12).font('Helvetica-Bold').text('Monatliche Aufschlüsselung')
    doc.moveDown(0.3)
    this.renderMonthlyTable(doc, data.monthlyBreakdown)
    doc.moveDown(0.8)

    // Lines table
    doc.fontSize(12).font('Helvetica-Bold').text('BMF Vordruck — Kennziffern')
    doc.moveDown(0.3)
    this.renderLinesTable(doc, data.lines)
    doc.moveDown(0.8)

    // Summary
    doc.fontSize(13).font('Helvetica-Bold')
    doc.text(
      `Zahllast (Kz 68): ${this.fmtEur(data.totals.zahllast)} €  |  ` +
        `Sondervorauszahlung (Kz 39): ${this.fmtEur(data.totals.sondervorauszahlung)} €  |  ` +
        `Restzahlung (Kz 69): ${this.fmtEur(data.totals.restzahlung)} €`,
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
          `de-invoice · UStJA Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderMonthlyTable(
    doc: PDFKit.PDFDocument,
    rows: UstjaMonthlyRow[],
  ): void {
    const tableTop = doc.y
    const colMonth = 50
    const colUSt = 220
    const colVSt = 340
    const colZahl = 460

    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Monat', colMonth, tableTop)
    doc.text('USt (Kz 66)', colUSt, tableTop, { width: 110, align: 'right' })
    doc.text('Vorsteuer (Kz 67)', colVSt, tableTop, { width: 110, align: 'right' })
    doc.text('Zahllast (Kz 68)', colZahl, tableTop, { width: 95, align: 'right' })
    doc.moveDown(0.3)
    doc
      .moveTo(colMonth, doc.y)
      .lineTo(555, doc.y)
      .strokeColor('#333')
      .lineWidth(0.5)
      .stroke()
    doc.moveDown(0.2)

    doc.font('Helvetica').fontSize(9)
    for (const r of rows) {
      const y = doc.y
      doc.text(r.monthLabel, colMonth, y)
      doc.text(this.fmtEur(r.umsatzsteuer), colUSt, y, {
        width: 110,
        align: 'right',
      })
      doc.text(this.fmtEur(r.vorsteuer), colVSt, y, {
        width: 110,
        align: 'right',
      })
      doc.text(this.fmtEur(r.zahllast), colZahl, y, {
        width: 95,
        align: 'right',
      })
      doc.moveDown(0.15)
    }
  }

  private renderLinesTable(
    doc: PDFKit.PDFDocument,
    lines: UstjaLine[],
  ): void {
    const tableTop = doc.y
    const colKz = 40
    const colLabel = 75
    const colNet = 380
    const colVat = 470

    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Kz', colKz, tableTop)
    doc.text('Bezeichnung', colLabel, tableTop)
    doc.text('Bemessung (€)', colNet, tableTop, { width: 80, align: 'right' })
    doc.text('Steuer (€)', colVat, tableTop, { width: 85, align: 'right' })
    doc.moveDown(0.3)
    doc
      .moveTo(colKz, doc.y)
      .lineTo(555, doc.y)
      .strokeColor('#333')
      .lineWidth(0.5)
      .stroke()
    doc.moveDown(0.2)

    doc.font('Helvetica').fontSize(9)
    for (const l of lines) {
      const y = doc.y
      doc.text(l.kennziffer, colKz, y)
      doc.text(l.label, colLabel, y, { width: 300 })
      const val = l.amount ?? l.net ?? 0
      doc.text(this.fmtEur(val), colNet, y, { width: 80, align: 'right' })
      doc.text(this.fmtEur(l.vat ?? 0), colVat, y, { width: 85, align: 'right' })
      doc.moveDown(0.15)
    }
  }

  private fmtEur(n: number): string {
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }
}
