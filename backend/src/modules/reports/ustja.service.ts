import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { UstvaData, UstvaService } from './ustva.service'
import { sumUstva, ustjaKennzahlen } from './ust-kennzahlen'
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
 * Kennzahlen: USt 2 A 2026 (BMF-Schreiben vom 29.12.2025), mapped in
 * ust-kennzahlen.ts. Tier 417 replaced an invented numbering (Kz 20-23,
 * 26-29, 36, 66-69, 39, 81) that matched neither the annual nor the monthly
 * form.
 */
export interface UstjaLine {
  kennziffer: string
  label: string
  net?: number
  vat?: number
  amount?: number
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
    umsatzsteuer: number
    vorsteuer: number
    /** Verbleibende Umsatzsteuer (Umsatzsteuer − Vorsteuer) */
    zahllast: number
    /** Sum of the monthly returns as computed — the Finanzamt's Soll governs */
    vorauszahlungssoll: number
    /** zahllast − vorauszahlungssoll */
    abschlusszahlung: number
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
    // Tier 417: the months are summed into one UstvaData and mapped onto the
    // USt 2 A 2026 Kennzahlen (ust-kennzahlen.ts). The lines used an invented
    // numbering (19 % as "Kz 20", the Zahllast as "Kz 81" — on the form Kz 81
    // is the 19 % base of the monthly return) and the § 13b tax as net × 19 %.
    const monthlyBreakdown: UstjaMonthlyRow[] = []
    const present: UstvaData[] = []
    let monthsWithData = 0
    monthlyResults.forEach((m, i) => {
      if (!m) {
        monthlyBreakdown.push({ month: i + 1, monthLabel: MONTH_LABELS[i], umsatzsteuer: 0, vorsteuer: 0, zahllast: 0 })
        return
      }
      if (m.umsatzsteuer !== 0 || m.vorsteuerSum !== 0 || m.igL !== 0) monthsWithData++
      present.push(m)
      monthlyBreakdown.push({
        month: i + 1,
        monthLabel: MONTH_LABELS[i],
        umsatzsteuer: round2(m.umsatzsteuer),
        vorsteuer: round2(m.vorsteuerSum),
        zahllast: round2(m.differenzbetrag),
      })
    })
    const annual = sumUstva(present, { companyId, year, periodLabel: String(year) })
    const lines: UstjaLine[] = ustjaKennzahlen(annual)
      .filter((e) => e.value !== 0)
      .map((e) => ({
        kennziffer: e.kz,
        label: e.label,
        ...(e.kind === 'tax' ? { vat: e.value } : { net: e.value, amount: e.value }),
        ...(e.tax != null ? { vat: e.tax } : {}),
        source: 'computed' as const,
      }))

    // ── Totals ──────────────────────────────────────
    // Verbleibende Umsatzsteuer = Umsatzsteuer − Vorsteuer. The form then
    // subtracts the Vorauszahlungssoll (the year's advance payments,
    // including a Sondervorauszahlung) to get the Abschlusszahlung. The
    // Sondervorauszahlung used to be computed as January's Zahllast / 11; on
    // the form it is 1/11 of the *previous* year's advance payments, and it
    // only exists under Dauerfristverlängerung. Here the Soll is the sum of
    // the monthly returns as computed — the Finanzamt's assessed Soll is what
    // counts, so the Abschlusszahlung shown is the difference to that sum.
    const umsatzsteuerTotal = round2(annual.umsatzsteuer)
    const vorsteuerTotal = round2(annual.vorsteuerSum)
    const zahllast = round2(umsatzsteuerTotal - vorsteuerTotal)
    const vorauszahlungssoll = round2(present.reduce((a, m) => a + m.differenzbetrag, 0))
    const abschlusszahlung = round2(zahllast - vorauszahlungssoll)

    return {
      year,
      companyId,
      periodLabel: `01.01.${year} – 31.12.${year}`,
      lines,
      totals: {
        umsatzsteuer: umsatzsteuerTotal,
        vorsteuer: vorsteuerTotal,
        zahllast,
        vorauszahlungssoll,
        abschlusszahlung,
      },
      monthlyBreakdown,
      counts: {
        hasData: monthsWithData > 0,
        monthsWithData,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus den 12 monatlichen UStVA-Daten ' +
        `(${year}) aggregiert (§ 18 Abs. 3 UStG). Kennzahlen nach dem Vordruckmuster ` +
        'USt 2 A 2026 (BMF-Schreiben vom 29.12.2025). Grundlage: alle finalisierten ' +
        'Rechnungen (status=paid/sent/overdue) und Eingangsrechnungen ' +
        '(status=booked/deductible) im Zeitraum. Das Vorauszahlungssoll ist hier die ' +
        'Summe der berechneten Monatswerte; maßgeblich ist das vom Finanzamt ' +
        'festgesetzte Soll einschließlich einer Sondervorauszahlung. Sonstige ' +
        'steuerfreie Umsätze sind nach ihrer Befreiungsvorschrift einer Kennzahl ' +
        'zuzuordnen. Der Berater prüft die Werte vor der Übermittlung.',
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
    doc.fontSize(12).font('Helvetica-Bold').text('Kennzahlen (Vordruck USt 2 A 2026)')
    doc.moveDown(0.3)
    this.renderLinesTable(doc, data.lines)
    doc.moveDown(0.8)

    // Summary
    doc.fontSize(13).font('Helvetica-Bold')
    doc.text(
      `Verbleibende Umsatzsteuer: ${this.fmtEur(data.totals.zahllast)} €  |  ` +
        `Vorauszahlungssoll: ${this.fmtEur(data.totals.vorauszahlungssoll)} €  |  ` +
        `Abschlusszahlung: ${this.fmtEur(data.totals.abschlusszahlung)} €`,
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
