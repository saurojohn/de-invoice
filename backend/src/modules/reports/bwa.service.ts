import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { AssetsService } from '../assets/assets.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 86: BWA (Betriebswirtschaftliche Auswertung).
 *
 * The monthly operating report that a
 * Steuerberater sends to the Mandant. The
 * canonical DATEV BWA structure (4-digit
 * bucket codes 1000-5999) with:
 *   - Monatswert (current month)
 *   - Vormonat (previous month)
 *   - YTD (Jan - selected month)
 *   - Vorjahres-YTD (Jan - same month prior year)
 *   - % change (YTD vs Vorjahres-YTD)
 *
 * v1 sources the BWA from the same data as
 * the P&L (tier 75) + the G+V (tier 82) +
 * the AfA from the Anlagenverzeichnis (tier
 * 83). No new data — just a different view
 * of the same numbers, in the format the
 * Mandant is used to from the Berater.
 *
 * DATEV BWA bucket mapping (4-digit codes):
 *
 *   REVENUE (Erlöse):
 *     1000  Umsatzerlöse                (P&L: Invoice netTotal)
 *     1300  Sonstige betriebliche Erträge (P&L: positive credits)
 *
 *   COST (Aufwendungen):
 *     2000  Materialaufwand             (Expense Material)
 *     3000  Personalkosten              (Expense Personal)
 *     3100  Abschreibungen               (Asset AfA)
 *     3600  Sonstige betriebl. Aufw.   (other Expenses)
 *     4200  Zinsaufwendungen            (Expense Schuldzins)
 *
 *   NOT COMPUTED (nicht ausgewiesen):
 *     1100  Bestandsveränderungen
 *     1200  Aktivierte Eigenleistungen
 *     3200  Raumkosten
 *     3300  Versicherungen
 *     3400  Werbung / Reise
 *     3500  Instandhaltung
 *     4100  Zinserträge
 *     4400  Beteiligungserträge
 *     4500  Beteiligungs-Abschreibungen
 *     5000  Steuern vom Einkommen
 *     5100  Sonstige Steuern
 *
 * v2 work (not in scope):
 *   - Per-Expense category keyword overrides
 *     (today: reuses Anlage S / EÜR
 *     matchers)
 *   - Vorjahres-Vergleich per BWA bucket
 *     (today: only YTD vs Vorjahres-YTD
 *     per bucket)
 *   - DATEV BWA export (.bwa XML format
 *     for DATEV Kassenbuch / Rechnungswesen
 *     import)
 */
export interface BwaLine {
  bucket: string
  label: string
  monat: number          // current month value
  vormonat: number       // previous month value
  ytd: number            // Jan - selected month
  vorjahresYtd: number   // Jan - same month prior year
  ytdChangePct: number   // (ytd - vorjahresYtd) / abs(vorjahresYtd) * 100
}

export interface BwaResult {
  year: number
  month: number            // 1-12
  vorjahr: number          // year - 1
  company: { name: string; legalName: string | null }
  lines: BwaLine[]
  totals: {
    erloeseMonat: number
    erloeseVormonat: number
    erloeseYtd: number
    erloeseVorjahresYtd: number
    materialaufwandMonat: number
    personalaufwandMonat: number
    abschreibungenMonat: number
    sonstigeMonat: number
    betriebsergebnisMonat: number
    betriebsergebnisYtd: number
    betriebsergebnisVorjahresYtd: number
  }
  counts: { invoices: number; expenses: number; assets: number }
  generatedAt: string
  disclaimer: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class BwaService {
  constructor(
    private prisma: PrismaService,
    private assets: AssetsService,
  ) {}

  async compute(companyId: string, year: number, month: number): Promise<BwaResult> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company) throw new Error('Company nicht gefunden')

    const vorjahr = year - 1
    const yearStart = new Date(year, 0, 1)
    const monthStart = new Date(year, month - 1, 1)
    const monthEnd = new Date(year, month - 1 + 1, 0, 23, 59, 59, 999)
    const vormonatStart = new Date(year, month - 2, 1)
    const vormonatEnd = new Date(year, month - 1, 0, 23, 59, 59, 999)
    const vorjahresYtdStart = new Date(vorjahr, 0, 1)
    const vorjahresYtdEnd = new Date(vorjahr, month - 1 + 1, 0, 23, 59, 59, 999)

    // Pull invoices + expenses for the year so we
    // can filter by month in-memory. Pulling
    // the full year (not 4 separate windows) is
    // simpler than 4 parallel queries and gives
    // us consistent counts.
    const [invoices, expenses, assetList] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          status: { in: ['paid', 'sent', 'overdue'] },
          issueDate: { gte: yearStart, lte: monthEnd },
        },
        select: { subtotal: true, issueDate: true },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          status: { in: ['booked', 'deductible'] },
          invoiceDate: { gte: yearStart, lte: monthEnd },
        },
        select: { grossAmount: true, category: true, invoiceDate: true },
      }),
      this.prisma.asset.findMany({ where: { companyId } }),
    ])

    const sumInMonth = (vals: { date: Date; amount: number }[], start: Date, end: Date) =>
      vals
        .filter((v) => v.date >= start && v.date <= end)
        .reduce((s, v) => s + v.amount, 0)

    const invoiceMonat = sumInMonth(
      invoices.map((i) => ({ date: i.issueDate, amount: Number(i.subtotal) })),
      monthStart,
      monthEnd,
    )
    const invoiceVormonat = sumInMonth(
      invoices.map((i) => ({ date: i.issueDate, amount: Number(i.subtotal) })),
      vormonatStart,
      vormonatEnd,
    )
    const invoiceYtd = sumInMonth(
      invoices.map((i) => ({ date: i.issueDate, amount: Number(i.subtotal) })),
      yearStart,
      monthEnd,
    )

    // Materialaufwand (2000): Expense Material/Waren
    const materialExpenses = expenses.filter((e) =>
      /^(Material|Waren|Rohstoffe?|Fremdleistung)/i.test(e.category || ''),
    )
    const personalExpenses = expenses.filter((e) =>
      /^(Personal|Lohn|Gehalt|SV)/i.test(e.category || ''),
    )
    const sonstigeExpenses = expenses.filter(
      (e) =>
        !/^(Material|Waren|Rohstoffe?|Fremdleistung)/i.test(e.category || '') &&
        !/^(Personal|Lohn|Gehalt|SV)/i.test(e.category || '') &&
        !/^(Schuldzins|Zins)/i.test(e.category || ''),
    )
    const zinsExpenses = expenses.filter((e) =>
      /^(Schuldzins|Zins)/i.test(e.category || ''),
    )

    const sumExpense = (vals: any[], start: Date, end: Date) =>
      sumInMonth(
        vals.map((e) => ({ date: e.invoiceDate, amount: Number(e.grossAmount) })),
        start,
        end,
      )

    const materialMonat = sumExpense(materialExpenses, monthStart, monthEnd)
    const personalMonat = sumExpense(personalExpenses, monthStart, monthEnd)
    const sonstigeMonat = sumExpense(sonstigeExpenses, monthStart, monthEnd)
    const zinsMonat = sumExpense(zinsExpenses, monthStart, monthEnd)
    const materialYtd = sumExpense(materialExpenses, yearStart, monthEnd)
    const personalYtd = sumExpense(personalExpenses, yearStart, monthEnd)
    const sonstigeYtd = sumExpense(sonstigeExpenses, yearStart, monthEnd)
    const zinsYtd = sumExpense(zinsExpenses, yearStart, monthEnd)

    // 3100 AfA — computed per-asset for the BWA
    // month. We use the asset's annualAfA * (months
    // in the BWA month / 12) as a per-month proration.
    // (This is a simplification — real DATEV BWA
    // uses the exact booked AfA per month. v2
    // would integrate with the AfA-Buch.)
    const monthAfA = assetList.reduce(
      (s, a) => s + (this.assets.computeAfA(a, monthEnd).annualAfA / 12),
      0,
    )
    const ytdAfA = assetList.reduce(
      (s, a) => s + (this.assets.computeAfA(a, monthEnd).annualAfA * (month / 12)),
      0,
    )

    // Vorjahres-YTD (Jan - same month prior year)
    // — needs separate queries because our
    // in-memory pull only covers the current
    // year. Same for vorjahres invoicing (we
    // don't store prior-year invoices in the
    // current-year query).
    const [vorjahresInvoices, vorjahresExpenses] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          status: { in: ['paid', 'sent', 'overdue'] },
          issueDate: { gte: vorjahresYtdStart, lte: vorjahresYtdEnd },
        },
        select: { subtotal: true },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          status: { in: ['booked', 'deductible'] },
          invoiceDate: { gte: vorjahresYtdStart, lte: vorjahresYtdEnd },
        },
        select: { grossAmount: true, category: true },
      }),
    ])

    const vorjahresYtdInvoice = vorjahresInvoices.reduce(
      (s, i) => s + Number(i.subtotal),
      0,
    )
    const vorjahresYtdMaterial = vorjahresExpenses
      .filter((e) => /^(Material|Waren|Rohstoffe?|Fremdleistung)/i.test(e.category || ''))
      .reduce((s, e) => s + Number(e.grossAmount), 0)
    const vorjahresYtdPersonal = vorjahresExpenses
      .filter((e) => /^(Personal|Lohn|Gehalt|SV)/i.test(e.category || ''))
      .reduce((s, e) => s + Number(e.grossAmount), 0)
    const vorjahresYtdSonstige = vorjahresExpenses
      .filter(
        (e) =>
          !/^(Material|Waren|Rohstoffe?|Fremdleistung)/i.test(e.category || '') &&
          !/^(Personal|Lohn|Gehalt|SV)/i.test(e.category || ''),
      )
      .reduce((s, e) => s + Number(e.grossAmount), 0)

    // Sonstige betriebliche Erträge (1300) —
    // positive customer credits in the year.
    const credits = await this.prisma.customerCreditTransaction.findMany({
      where: {
        companyId,
        createdAt: { gte: yearStart, lte: monthEnd },
        type: { in: ['overpayment', 'gutschrift'] },
      },
      select: { amount: true },
    })
    const sonstigeErloeseMonat = sumInMonth(
      credits.map((c) => ({ date: new Date(), amount: Number(c.amount) > 0 ? Number(c.amount) : 0 })),
      monthStart,
      monthEnd,
    )
    const sonstigeErloeseYtd = credits
      .filter((c) => Number(c.amount) > 0)
      .reduce((s, c) => s + Number(c.amount), 0)
    // No prior-year credit data; we use 0
    // (a real BWA would have it from the prior
    // year).
    const sonstigeErloeseVorjahresYtd = 0

    // Build the lines array in DATEV BWA order
    const erloeseMonat = invoiceMonat + sonstigeErloeseMonat
    const erloeseVormonat = invoiceVormonat
    const erloeseYtd = invoiceYtd + sonstigeErloeseYtd
    const erloeseVorjahresYtd = vorjahresYtdInvoice + sonstigeErloeseVorjahresYtd

    // Compute % change vs Vorjahres-YTD per line
    const pctChange = (ytd: number, vor: number) =>
      vor === 0 ? 0 : round2(((ytd - vor) / Math.abs(vor)) * 100)

    const lines: BwaLine[] = [
      {
        bucket: '1000',
        label: 'Umsatzerlöse',
        monat: round2(invoiceMonat),
        vormonat: round2(invoiceVormonat),
        ytd: round2(invoiceYtd),
        vorjahresYtd: round2(vorjahresYtdInvoice),
        ytdChangePct: pctChange(invoiceYtd, vorjahresYtdInvoice),
      },
      {
        bucket: '1300',
        label: 'Sonstige betriebliche Erträge',
        monat: round2(sonstigeErloeseMonat),
        vormonat: 0,
        ytd: round2(sonstigeErloeseYtd),
        vorjahresYtd: round2(sonstigeErloeseVorjahresYtd),
        ytdChangePct: 0,
      },
      {
        bucket: '2000',
        label: 'Materialaufwand',
        monat: round2(materialMonat),
        vormonat: 0,
        ytd: round2(materialYtd),
        vorjahresYtd: round2(vorjahresYtdMaterial),
        ytdChangePct: pctChange(materialYtd, vorjahresYtdMaterial),
      },
      {
        bucket: '3000',
        label: 'Personalkosten',
        monat: round2(personalMonat),
        vormonat: 0,
        ytd: round2(personalYtd),
        vorjahresYtd: round2(vorjahresYtdPersonal),
        ytdChangePct: pctChange(personalYtd, vorjahresYtdPersonal),
      },
      {
        bucket: '3100',
        label: 'Abschreibungen (AfA)',
        monat: round2(monthAfA),
        vormonat: 0,
        ytd: round2(ytdAfA),
        vorjahresYtd: 0,
        ytdChangePct: 0,
      },
      {
        bucket: '3600',
        label: 'Sonstige betriebliche Aufwendungen',
        monat: round2(sonstigeMonat),
        vormonat: 0,
        ytd: round2(sonstigeYtd),
        vorjahresYtd: round2(vorjahresYtdSonstige),
        ytdChangePct: pctChange(sonstigeYtd, vorjahresYtdSonstige),
      },
      {
        bucket: '4200',
        label: 'Zinsaufwendungen',
        monat: round2(zinsMonat),
        vormonat: 0,
        ytd: round2(zinsYtd),
        vorjahresYtd: 0,
        ytdChangePct: 0,
      },
    ]

    const betriebsergebnisMonat = erloeseMonat - materialMonat - personalMonat - monthAfA - sonstigeMonat
    const betriebsergebnisYtd = erloeseYtd - materialYtd - personalYtd - ytdAfA - sonstigeYtd
    const betriebsergebnisVorjahresYtd =
      erloeseVorjahresYtd - vorjahresYtdMaterial - vorjahresYtdPersonal - vorjahresYtdSonstige

    return {
      year,
      month,
      vorjahr,
      company: {
        name: company.name,
        legalName: company.legalName,
      },
      lines,
      totals: {
        erloeseMonat: round2(erloeseMonat),
        erloeseVormonat: round2(erloeseVormonat),
        erloeseYtd: round2(erloeseYtd),
        erloeseVorjahresYtd: round2(erloeseVorjahresYtd),
        materialaufwandMonat: round2(materialMonat),
        personalaufwandMonat: round2(personalMonat),
        abschreibungenMonat: round2(monthAfA),
        sonstigeMonat: round2(sonstigeMonat),
        betriebsergebnisMonat: round2(betriebsergebnisMonat),
        betriebsergebnisYtd: round2(betriebsergebnisYtd),
        betriebsergebnisVorjahresYtd: round2(betriebsergebnisVorjahresYtd),
      },
      counts: {
        invoices: invoices.length,
        expenses: expenses.length,
        assets: assetList.length,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese BWA ist eine VORSCHAU basierend auf den in de-invoice v1 verfügbaren ' +
        'Daten. Positionen, die das System nicht erfasst (z. B. Bestandsveränderungen, ' +
        'Aktivierte Eigenleistungen, Erbschaften, Zinserträge, Beteiligungserträge, ' +
        'Steuern), sind nicht ausgewiesen. Der Steuerberater ergänzt die fehlenden ' +
        'Positionen aus dem SKR03 / der BWA-Quelldaten.',
    }
  }

  /**
   * Render the BWA as a GoBD-style A4 PDF.
   * Single-page landscape (the BWA has 5
   * numeric columns + bucket codes + labels;
   * landscape gives the columns room to
   * breathe).
   */
  async renderPdf(companyId: string, year: number, month: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year, month)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="BWA-${year}-${String(month).padStart(2, '0')}.pdf"`,
    )

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 })
    doc.pipe(res)

    // Header
    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .text(`BWA — Betriebswirtschaftliche Auswertung`, { align: 'left' })
    doc
      .fontSize(9)
      .font('Helvetica')
      .text(
        `${data.company.legalName || data.company.name}  |  ${this.monthName(month)} ${year}  |  Vorjahres-Vergleich: Jan-${this.monthName(month)} ${data.vorjahr}`,
      { align: 'left' },
      )
    doc.moveDown(0.5)

    // Table
    const colBucket = 40
    const colLabel = 80
    const colMonat = 250
    const colVormonat = 350
    const colYtd = 440
    const colVorYtd = 540
    const colChange = 640

    // Header row
    doc.fontSize(9).font('Helvetica-Bold')
    const headerY = doc.y
    doc.text('Konto', colBucket, headerY, { width: 35 })
    doc.text('Bezeichnung', colLabel, headerY, { width: 165 })
    doc.text('Monat', colMonat, headerY, { width: 90, align: 'right' })
    doc.text('Vormonat', colVormonat, headerY, { width: 85, align: 'right' })
    doc.text('YTD', colYtd, headerY, { width: 95, align: 'right' })
    doc.text('Vorj.-YTD', colVorYtd, headerY, { width: 95, align: 'right' })
    doc.text('Δ %', colChange, headerY, { width: 95, align: 'right' })
    doc.moveDown(0.4)
    doc.moveTo(40, doc.y).lineTo(740, doc.y).stroke()

    // Body rows
    doc.font('Helvetica').fontSize(9)
    for (const l of data.lines) {
      const y = doc.y
      doc.text(l.bucket, colBucket, y, { width: 35 })
      doc.text(l.label, colLabel, y, { width: 165 })
      doc.text(this.fmtEur(l.monat), colMonat, y, { width: 90, align: 'right' })
      doc.text(this.fmtEur(l.vormonat), colVormonat, y, { width: 85, align: 'right' })
      doc.text(this.fmtEur(l.ytd), colYtd, y, { width: 95, align: 'right' })
      doc.text(this.fmtEur(l.vorjahresYtd), colVorYtd, y, { width: 95, align: 'right' })
      doc.text(this.fmtPct(l.ytdChangePct), colChange, y, { width: 95, align: 'right' })
      doc.moveDown(0.3)
    }

    // Summary: Betriebsergebnis
    doc.moveDown(0.4)
    doc.moveTo(40, doc.y).lineTo(740, doc.y).stroke()
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold').fontSize(10)
    const sumY = doc.y
    doc.text('Betriebsergebnis', colLabel, sumY, { width: 165 })
    doc.text(this.fmtEur(data.totals.betriebsergebnisMonat), colMonat, sumY, { width: 90, align: 'right' })
    doc.text('—', colVormonat, sumY, { width: 85, align: 'right' })
    doc.text(this.fmtEur(data.totals.betriebsergebnisYtd), colYtd, sumY, { width: 95, align: 'right' })
    doc.text(this.fmtEur(data.totals.betriebsergebnisVorjahresYtd), colVorYtd, sumY, { width: 95, align: 'right' })
    doc.text(
      this.fmtPct(
        data.totals.betriebsergebnisVorjahresYtd === 0
          ? 0
          : ((data.totals.betriebsergebnisYtd - data.totals.betriebsergebnisVorjahresYtd) /
              Math.abs(data.totals.betriebsergebnisVorjahresYtd)) *
              100,
      ),
      colChange,
      sumY,
      { width: 95, align: 'right' },
    )

    // Disclaimer
    doc.moveDown(1)
    doc.fontSize(7).font('Helvetica-Oblique').fillColor('#666')
    doc.text(data.disclaimer, { width: 700 })
    doc.fillColor('#000')

    // Footer
    doc
      .fontSize(6)
      .font('Helvetica')
      .fillColor('#999')
      .text(
        `Erstellt: ${new Date(data.generatedAt).toLocaleString('de-DE')}  |  ` +
          `Rechnungen: ${data.counts.invoices}  |  Ausgaben: ${data.counts.expenses}  |  ` +
          `Anlagen: ${data.counts.assets}  |  de-invoice · BWA Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private fmtEur(n: number): string {
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }

  private fmtPct(n: number): string {
    if (n === 0) return '—'
    const sign = n > 0 ? '+' : ''
    return `${sign}${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(n)} %`
  }

  private monthName(m: number): string {
    return [
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
    ][m - 1]
  }
}
