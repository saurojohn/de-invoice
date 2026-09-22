import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { AssetsService, DEFAULT_BILANZ_KONTO } from '../assets/assets.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'
import { CLAIM_TYPES } from '../invoice/document-scope'

/**
 * Tier 81: Bilanz (Balance Sheet) — VORSCHAU.
 *
 * The year-end balance sheet for Bilanz-pflichtige
 * entities (GmbH, AG, etc. per § 264 HGB). A full
 * Bilanz requires tracking that de-invoice v1
 * does NOT have: AfA on Anlagevermögen,
 * Eigenkapital-Bewegungen, Rückstellungen,
 * Rechnungsabgrenzungsposten, etc.
 *
 * v1 honesty: we compute ONLY what we can derive
 * from existing data, and mark the rest
 * "nicht ausgewiesen" (not stated). The Bilanz
 * preview is useful as a VORSCHAU even incomplete
 * — the Berater (Steuerberater) knows which
 * positions need manual completion.
 *
 * Positions we DO compute in v1:
 *   - Aktiva / Umlaufvermögen
 *     - 1500 Forderungen aus L+L: open invoices
 *       (sent/overdue) at year-end, summed.
 *     - 1600+1700 Liquide Mittel: cash book
 *       balance at year-end (Eröffnung + sum of
 *       Einnahme - sum of Ausgabe). Split Kasse
 *       vs. Bank requires the cash book to
 *       differentiate; v1 combines them.
 *     - 1800 Sonstige Forderungen: positive
 *       customer-credit balances (the company
 *       owes customers money — a liability in
 *       disguise; we surface it here as
 *       "negative" Forderung for visibility).
 *       We actually have customer credits on
 *       the LIABILITY side; see below.
 *   - Passiva / Verbindlichkeiten
 *     - 4000 Verb. aus L+L: open expenses
 *       (booked/deductible) at year-end, gross.
 *     - 4500 Sonstige Verb. (Kundenguthaben):
 *       sum of positive customer-credit balances
 *       (Kundenguthaben the company owes the
 *       customer).
 *   - Eigenkapital
 *     - SALDOPOSTEN: a derived "Equity" line that
 *       makes the Bilanzgleichung balance. The
 *       user/Berater replaces this with the
 *       real equity from the Eigenkapital-Konto
 *       in the SKR03.
 *
 * v2 work (not in scope here):
 *   - Anlagevermögen: requires AfA tracking on
 *     Sachanlagen + GWG pool. Add to Expense
 *     model: `afaDurationMonths Int?` + a
 *     depreciation schedule.
 *   - Rückstellungen: requires a new
 *     Provision model + period-end accrual
 *     workflow.
 *   - Eigenkapital real values: requires
 *     tracking Kapitalkonto + Gewinnrücklage
 *     + Bilanzgewinn movements through the year.
 *   - E-Bilanz: BMF XBRL taxonomy export. A
 *     separate tier (probably a week+ of work).
 */

export interface BilanzLine {
  position: string       // e.g. "1500"
  label: string          // e.g. "Forderungen aus Lieferungen und Leistungen"
  amount: number | null  // null = nicht ausgewiesen
  note?: string          // optional explanation
}

export interface BilanzSection {
  title: string          // e.g. "A. Anlagevermögen"
  lines: BilanzLine[]
  subtotal: number | null
  nichtAusgewiesen: number  // count of lines that are null
}

export interface BilanzResult {
  year: number
  companyId: string
  /** § 266 HGB Aktiva: A. Anlagevermögen, B. Umlaufvermögen, C. RAP */
  aktiva: BilanzSection[]
  /** § 266 HGB Passiva: A. Eigenkapital, B. Rückstellungen, C. Verb., D. RAP */
  passiva: BilanzSection[]
  totals: {
    aktiva: number       // sum of all Aktiva positions
    passiva: number      // sum of all Passiva positions
    eigenkapital: number // Saldoposten = Aktiva - Passiva (excluding Eigenkapital)
  }
  balanceCheck: {
    /** true if Aktiva total == Passiva total (Bilanzgleichung) */
    balanced: boolean
    diff: number
  }
  generatedAt: string
  disclaimer: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class BilanzService {
  constructor(
    private prisma: PrismaService,
    private assets: AssetsService,
  ) {}

  async compute(companyId: string, year: number): Promise<BilanzResult> {
    // Snapshot date = end of fiscal year.
    // Using Dec 31, 23:59:59.999 because the
    // Bilanz is a point-in-time view, not a
    // period view (unlike the G+V / EÜR).
    const snapshot = new Date(year, 11, 31, 23, 59, 59, 999)

    // Tier 83: pull the Asset pool and compute
    // the per-position Buchwert. The 0100-0500
    // Anlagevermögen positions get real numbers
    // for companies that have registered
    // Sachanlagen. Companies without assets
    // still see the lines as "nicht
    // ausgewiesen" (the per-position amount
    // stays null).
    //
    // Boundary convention: an asset disposed on
    // the snapshot date itself is STILL in the
    // pool. The disposal is a year-end event
    // that lands on the next year's books
    // (Veräußerungserlös vs Buchwert) — the
    // Bilanz for year Y still shows the asset
    // at its Buchwert, because it was owned
    // for almost all of year Y. We use `gte`
    // rather than `gt` on the verkauftAm
    // cutoff to capture this.
    const allAssets = await this.prisma.asset.findMany({
      where: {
        companyId,
        OR: [
          { verkauftAm: null },
          { verkauftAm: { gte: snapshot } },
        ],
      },
    })
    const afaSummaries = allAssets.map((a) => this.assets.computeAfA(a, snapshot))

    // Group the asset pool by § 266 HGB position
    // (computed from `type` via the
    // DEFAULT_BILANZ_KONTO map, with the
    // user-overridden `bilanzKonto` winning if
    // set).
    const poolByPosition: Record<string, number> = {
      '0100': 0,
      '0200': 0,
      '0300': 0,
      '0400': 0,
      '0500': 0,
    }
    const hasAssets = afaSummaries.length > 0
    for (const summary of afaSummaries) {
      const asset = allAssets.find((a) => a.id === summary.assetId)!
      const pos = asset.bilanzKonto || DEFAULT_BILANZ_KONTO[asset.type as keyof typeof DEFAULT_BILANZ_KONTO] || '0400'
      poolByPosition[pos] = (poolByPosition[pos] || 0) + summary.buchwert
    }

    // ===== AKTIVA =====

    // 1500 Forderungen aus L+L: sum of open
    // (unpaid) invoices at snapshot. Includes
    // 'sent' and 'overdue' — 'paid' is excluded
    // (the money is in the bank). 'draft' is
    // excluded (not yet billable).
    const openInvoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        status: { in: ['sent', 'overdue'] },
        type: { in: CLAIM_TYPES }, // Tier 424: not a Proforma
        issueDate: { lte: snapshot },
      },
      select: { total: true },
    })
    const forderungenLUL = openInvoices.reduce(
      (s, inv) => s.plus(inv.total),
      new Prisma.Decimal(0),
    ).toNumber()

    // 1600/1700 Liquide Mittel: cash book
    // balance at snapshot. The cash book is
    // a single running balance — we don't
    // differentiate Kasse vs. Bank in v1
    // (no separate fields on CashBookEntry).
    // Einnahme = +amount, Ausgabe = -amount,
    // Eröffnung = +amount (initial balance).
    const cashEntries = await this.prisma.cashBookEntry.findMany({
      where: { companyId, businessDate: { lte: snapshot } },
      select: { type: true, amount: true },
    })
    const liquideMittel = cashEntries.reduce((s, e) => {
      const amt = Number(e.amount)
      if (e.type === 'einnahme' || e.type === 'eroeffnung') return s + amt
      if (e.type === 'ausgabe' || e.type === 'umbuchung') return s - amt
      return s
    }, 0)

    // 1800 Sonstige Forderungen: we don't
    // currently track "Angestellten-Darlehen"
    // or "Steuer-Erstattungsansprüche" as
    // separate models. Mark nicht ausgewiesen.

    // ===== PASSIVA =====

    // 4000 Verb. aus L+L: open (unpaid) expenses
    // at snapshot. The "booked" status means
    // the Beleg is recorded but not yet paid
    // (= the company still owes the supplier).
    // The "deductible" status is for the input
    // tax side, not payment — same treatment.
    const openExpenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        status: { in: ['booked', 'deductible'] },
        invoiceDate: { lte: snapshot },
      },
      select: { grossAmount: true },
    })
    const verbLUL = openExpenses.reduce(
      (s, exp) => s.plus(exp.grossAmount ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    ).toNumber()

    // 4500 Sonstige Verb. (Kundenguthaben): the
    // CustomerCreditTransaction ledger (tier 58)
    // tracks customer credits. A positive
    // balance means the company owes the
    // customer (e.g. overpayment, Gutschrift-
    // overage). We sum the positive balances
    // here as a liability.
    const creditLedger = await this.prisma.customerCreditTransaction.findMany({
      where: { companyId },
      select: { amount: true },
    })
    const kundenguthaben = creditLedger.reduce(
      (s, t) => s + (Number(t.amount) > 0 ? Number(t.amount) : 0),
      0,
    )

    // ===== BUILD SECTIONS =====

    // Aktiva / A. Anlagevermögen — partially
    // computed (tier 83). The pool-by-position
    // sums feed 0100-0400; 0500 is still
    // nicht ausgewiesen (Anlagen im Bau) and
    // any position with no assets stays at
    // null. The subtotal is the sum across the
    // 5 positions.
    //
    // Note: a position with `poolByPosition = 0`
    // (e.g. fully-depreciated asset) is shown
    // as 0, not null — the user can SEE the
    // position is on the report (the asset
    // exists, just depreciated to zero). Only
    // positions with NO asset at all stay null.
    //
    // We track per-position "hasAnyAsset" so
    // a 0-value position still renders as
    // "0.00" instead of being hidden.
    const hasAnyAssetAt = (pos: string) =>
      afaSummaries.some(
        (s) => {
          const asset = allAssets.find((a) => a.id === s.assetId)!
          const mapped = asset.bilanzKonto || DEFAULT_BILANZ_KONTO[asset.type as keyof typeof DEFAULT_BILANZ_KONTO] || '0400'
          return mapped === pos
        },
      )

    const aktivaAV: BilanzSection = {
      title: 'A. Anlagevermögen',
      lines: [
        {
          position: '0100',
          label: 'Konzessionen, gewerbliche Schutzrechte und ähnliche Rechte',
          amount: hasAnyAssetAt('0100') ? round2(poolByPosition['0100'] || 0) : null,
        },
        {
          position: '0200',
          label: 'Grundstücke, grundstücksgleiche Rechte und Bauten',
          amount: hasAnyAssetAt('0200') ? round2(poolByPosition['0200'] || 0) : null,
        },
        {
          position: '0300',
          label: 'Technische Anlagen und Maschinen',
          amount: hasAnyAssetAt('0300') ? round2(poolByPosition['0300'] || 0) : null,
        },
        {
          position: '0400',
          label: 'Andere Anlagen, Betriebs- und Geschäftsausstattung',
          amount: hasAnyAssetAt('0400') ? round2(poolByPosition['0400'] || 0) : null,
        },
        {
          position: '0500',
          label: 'Geleistete Anzahlungen und Anlagen im Bau',
          amount: null,
          note: 'Anlagen im Bau werden in de-invoice v1 nicht separat erfasst.',
        },
      ],
      subtotal: hasAssets
        ? round2(
            (poolByPosition['0100'] || 0) +
            (poolByPosition['0200'] || 0) +
            (poolByPosition['0300'] || 0) +
            (poolByPosition['0400'] || 0),
          )
        : 0,
      nichtAusgewiesen: hasAssets ? 1 : 5,
    }

    // Aktiva / B. Umlaufvermögen — partial.
    const aktivaUV: BilanzSection = {
      title: 'B. Umlaufvermögen',
      lines: [
        {
          position: '1100',
          label: 'Roh-, Hilfs- und Betriebsstoffe',
          amount: null,
          note: 'Vorratsbestand wird in de-invoice v1 nicht erfasst.',
        },
        {
          position: '1500',
          label: 'Forderungen aus Lieferungen und Leistungen',
          amount: round2(forderungenLUL),
        },
        {
          position: '1600+1700',
          label: 'Kassenbestand, Guthaben bei Kreditinstituten',
          amount: round2(liquideMittel),
          note: 'Kasse und Bank werden zusammengefasst — Differenzierung in v2 möglich.',
        },
        {
          position: '1800',
          label: 'Sonstige Forderungen und Vermögensgegenstände',
          amount: null,
        },
      ],
      subtotal: round2(forderungenLUL + liquideMittel),
      nichtAusgewiesen: 2,
    }

    // Aktiva / C. RAP — nicht ausgewiesen.
    const aktivaRAP: BilanzSection = {
      title: 'C. Rechnungsabgrenzungsposten',
      lines: [
        { position: '1900', label: 'Aktive Rechnungsabgrenzungsposten', amount: null },
      ],
      subtotal: 0,
      nichtAusgewiesen: 1,
    }

    // Passiva / A. Eigenkapital — Saldoposten.
    // The "real" Eigenkapital (Gezeichnetes
    // Kapital, Rücklagen, Bilanzgewinn) is
    // tracked by the Berater outside the
    // system. v1 exposes a single "Saldoposten"
    // line so the Bilanzgleichung balances.
    const aktivaTotal = aktivaAV.subtotal! + aktivaUV.subtotal! + aktivaRAP.subtotal!
    const passivaKnown = verbLUL + kundenguthaben
    const eigenkapitalSaldoposten = aktivaTotal - passivaKnown

    const passivaEK: BilanzSection = {
      title: 'A. Eigenkapital',
      lines: [
        {
          position: '2000',
          label: 'Gezeichnetes Kapital',
          amount: null,
          note: 'Wird durch den Berater aus dem Handelsregister ergänzt.',
        },
        {
          position: '2100',
          label: 'Kapitalrücklage',
          amount: null,
        },
        {
          position: '2200',
          label: 'Gewinnrücklagen',
          amount: null,
        },
        {
          position: '2300',
          label: 'Gewinnvortrag / Verlustvortrag',
          amount: null,
        },
        {
          position: '2400',
          label: 'Jahresüberschuss / Jahresfehlbetrag',
          amount: null,
        },
        {
          position: 'EKV',
          label: 'Saldoposten (Aktiva − sonstige Passiva)',
          amount: round2(eigenkapitalSaldoposten),
          note: 'Platzhalter — durch den Berater durch die tatsächlichen Eigenkapital-Positionen ersetzen.',
        },
      ],
      subtotal: round2(eigenkapitalSaldoposten),
      nichtAusgewiesen: 5,
    }

    // Passiva / B. Rückstellungen — nicht
    // ausgewiesen.
    const passivaRueckstellungen: BilanzSection = {
      title: 'B. Rückstellungen',
      lines: [
        { position: '3000', label: 'Rückstellungen für Pensionen', amount: null },
        { position: '3100', label: 'Steuerrückstellungen', amount: null },
        { position: '3200', label: 'Sonstige Rückstellungen', amount: null },
      ],
      subtotal: 0,
      nichtAusgewiesen: 3,
    }

    // Passiva / C. Verbindlichkeiten — partial.
    const passivaVerb: BilanzSection = {
      title: 'C. Verbindlichkeiten',
      lines: [
        {
          position: '4000',
          label: 'Verbindlichkeiten aus Lieferungen und Leistungen',
          amount: round2(verbLUL),
        },
        {
          position: '4100',
          label: 'Verbindlichkeiten gegenüber Kreditinstituten',
          amount: null,
        },
        {
          position: '4200',
          label: 'Erhaltene Anzahlungen auf Bestellungen',
          amount: null,
        },
        {
          position: '4500',
          label: 'Verbindlichkeiten aus Lieferungen und Leistungen gegenüber Kunden (Kundenguthaben)',
          amount: round2(kundenguthaben),
          note: 'Gutgeschriebenes Guthaben, das noch nicht ausgezahlt / verrechnet wurde.',
        },
        {
          position: '4600',
          label: 'Sonstige Verbindlichkeiten',
          amount: null,
        },
      ],
      subtotal: round2(verbLUL + kundenguthaben),
      nichtAusgewiesen: 3,
    }

    // Passiva / D. RAP — nicht ausgewiesen.
    const passivaRAP: BilanzSection = {
      title: 'D. Rechnungsabgrenzungsposten',
      lines: [{ position: '4900', label: 'Passive Rechnungsabgrenzungsposten', amount: null }],
      subtotal: 0,
      nichtAusgewiesen: 1,
    }

    // Bilanzgleichung check.
    const passivaTotal = passivaEK.subtotal! + passivaRueckstellungen.subtotal! + passivaVerb.subtotal! + passivaRAP.subtotal!
    const balanced = Math.abs(aktivaTotal - passivaTotal) < 0.01

    return {
      year,
      companyId,
      aktiva: [aktivaAV, aktivaUV, aktivaRAP],
      passiva: [passivaEK, passivaRueckstellungen, passivaVerb, passivaRAP],
      totals: {
        aktiva: round2(aktivaTotal),
        passiva: round2(passivaTotal),
        eigenkapital: round2(eigenkapitalSaldoposten),
      },
      balanceCheck: {
        balanced,
        diff: round2(aktivaTotal - passivaTotal),
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Bilanz ist eine VORSCHAU. de-invoice v1 erfasst nicht alle ' +
        'Bilanzpositionen (AfA, Eigenkapital-Bewegungen, Rückstellungen, ' +
        'RAP) — diese Positionen sind als "nicht ausgewiesen" markiert. ' +
        'Der Berater ergänzt die fehlenden Positionen aus dem SKR03 bzw. ' +
        'dem Handelsregister. Der Saldoposten beim Eigenkapital ist ein ' +
        'Platzhalter und muss durch die tatsächlichen Eigenkapital-Werte ' +
        'ersetzt werden. Vor der Einreichung beim Finanzamt / ' +
        'Handelsregister durch den Steuerberater prüfen lassen.',
    }
  }

  /**
   * Render the Bilanz as a GoBD-style A4 PDF.
   * Standard § 266 HGB layout: Aktiva on the
   * left, Passiva on the right (Aktiva/Passiva
   * table side-by-side is the canonical German
   * accounting presentation; the data is
   * presented sequentially here for PDF
   * simplicity, but a v2 could render the
   * classical Kontenform with two columns).
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })

    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Bilanz-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Bilanz zum 31.12.${year}`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(`${company?.name || companyId}`)
      .moveDown(1)

    // Aktiva
    doc.fontSize(14).font('Helvetica-Bold').text('AKTIVA')
    doc.moveDown(0.3)
    for (const section of data.aktiva) {
      this.renderSection(doc, section)
      doc.moveDown(0.5)
    }

    // Passiva
    doc.addPage()
    doc.fontSize(14).font('Helvetica-Bold').text('PASSIVA')
    doc.moveDown(0.3)
    for (const section of data.passiva) {
      this.renderSection(doc, section)
      doc.moveDown(0.5)
    }

    // Bilanzgleichung check
    doc.moveDown(1)
    doc.fontSize(12).font('Helvetica-Bold')
    doc
      .fillColor(data.balanceCheck.balanced ? '#047857' : '#b91c1c')
      .text(
        data.balanceCheck.balanced
          ? '✓ Bilanzgleichung erfüllt: Aktiva = Passiva'
          : `✗ Bilanzgleichung verletzt: Differenz = ${this.fmtEur(data.balanceCheck.diff)} €`,
      )
      .fillColor('#000')
    doc.moveDown(1)

    // Disclaimer
    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .fillColor('#666')
      .text(data.disclaimer, { width: 495 })
      .fillColor('#000')

    // Footer
    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#999')
      .text(
        `Erstellt: ${new Date(data.generatedAt).toLocaleString('de-DE')}  |  ` +
          `Aktiva: ${this.fmtEur(data.totals.aktiva)} €  |  ` +
          `Passiva: ${this.fmtEur(data.totals.passiva)} €  |  ` +
          `de-invoice · Bilanz Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderSection(doc: PDFKit.PDFDocument, section: BilanzSection): void {
    doc.fontSize(11).font('Helvetica-Bold').text(section.title)
    doc.moveDown(0.2)
    const tableTop = doc.y
    const colPos = 50
    const colLabel = 90
    const colAmount = 380
    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Pos', colPos, tableTop, { continued: true })
    doc.text('Bezeichnung', colLabel, tableTop, { continued: true })
    doc.text('Betrag (€)', colAmount, tableTop, { width: 115, align: 'right' })
    doc.moveDown(0.2)
    doc.font('Helvetica')
    for (const l of section.lines) {
      const y = doc.y
      doc.fontSize(9)
      doc.text(l.position, colPos, y)
      doc.text(l.label, colLabel, y, { width: 280 })
      if (l.amount === null) {
        doc.fillColor('#999').text('— nicht ausgewiesen —', colAmount, y, { width: 115, align: 'right' }).fillColor('#000')
      } else {
        doc.text(this.fmtEur(l.amount), colAmount, y, { width: 115, align: 'right' })
      }
      doc.moveDown(0.15)
      if (l.note) {
        doc.fontSize(7).fillColor('#666').text(`↳ ${l.note}`, colLabel, doc.y, { width: 380 }).fillColor('#000')
        doc.moveDown(0.1)
      }
      doc.font('Helvetica')
    }
    doc.moveTo(colPos, doc.y).lineTo(495, doc.y).stroke()
    doc.moveDown(0.1)
    doc.font('Helvetica-Bold').fontSize(9)
    doc.text('Summe', colLabel, doc.y, { width: 280 })
    if (section.subtotal === null || section.subtotal === 0) {
      doc.fillColor('#999').text('—', colAmount, doc.y, { width: 115, align: 'right' }).fillColor('#000')
    } else {
      doc.text(this.fmtEur(section.subtotal), colAmount, doc.y, { width: 115, align: 'right' })
    }
  }

  private fmtEur(n: number): string {
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }
}
