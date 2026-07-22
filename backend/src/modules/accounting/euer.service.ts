import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Response } from 'express';
import PDFDocument from 'pdfkit';

/**
 * Tier 76: Anlage EÜR (Einnahmen-Überschuss-Rechnung).
 *
 * The official year-end tax filing form for small
 * businesses / freelancers (§ 18 EStG). The Berater
 * hands the PDF/XML to the Finanzamt; the user
 * (Mandant) sees a preview, verifies the numbers,
 * then hands the export to the Berater for the
 * final check.
 *
 * Important: this is a VORSCHAU (preview), not a
 * legally-binding filing. The mapping below is
 * keyword-based and a v2 would let the user
 * override the category → Kennziffer mapping per
 * expense. The PDF + the UI both surface a
 * "Vom Steuerberater prüfen lassen" disclaimer.
 *
 * Kennziffern covered (high-level BMF Anlage EÜR
 * 2026, simplified):
 *
 *   REVENUE (Betriebseinnahmen):
 *     4100  Umsatzerlöse umsatzsteuerpflichtig
 *     4120  Umsatzerlöse nach §19 UStG (Kleinunternehmer)
 *     4170  Sonstige steuerfreie Umsätze
 *     4190  Sonstige Betriebseinnahmen
 *
 *   EXPENSES (Betriebsausgaben):
 *     4300  Wareneinsatz (Material)
 *     5100  Personalkosten
 *     5400  Raumkosten
 *     5600  Werbe-/Reisekosten
 *     5800  Instandhaltung / EDV
 *     5900  Sonstige Aufwendungen
 *
 *   RESULT:
 *     Gewinn / Verlust = Summe Einnahmen − Summe Ausgaben
 *
 *   The forward-year Gewinn should equal the
 *   prior-year Betriebsergebnis from the BWA —
 *   same numbers, different bucket labels.
 */

export interface EuerLine {
  kennziffer: string;
  label: string;
  amount: number;
}

export interface EuerResult {
  year: number;
  companyId: string;
  einnahmen: EuerLine[];
  ausgaben: EuerLine[];
  totals: {
    einnahmenTotal: number;
    ausgabenTotal: number;
    gewinn: number; // einnahmenTotal - ausgabenTotal (positive = profit, negative = loss)
  };
  counts: {
    invoices: number;
    expenses: number;
  };
  generatedAt: string;
  disclaimer: string;
}

// BMF Anlage EÜR 2026 Kennziffern. Each row is
// { kz, label, matchCategory(category) → boolean }.
// The "matcher" is a keyword-based heuristic — a v2
// could let the user override the mapping per
// expense via a settings page.
const REVENUE_LINES: Array<{ kz: string; label: string; matcher: (inv: any) => boolean }> = [
  {
    kz: '4100',
    label: 'Umsatzerlöse (umsatzsteuerpflichtig)',
    // An invoice is "umsatzsteuerpflichtig" if it
    // has positive VAT. totalVat > 0.
    matcher: (inv) => Number(inv.totalVat) > 0,
  },
  {
    kz: '4120',
    label: 'Umsatzerlöse nach §19 UStG (Kleinunternehmer)',
    // §19: total === subtotal (no VAT charged)
    matcher: (inv) => Number(inv.totalVat) === 0 && Number(inv.subtotal) > 0,
  },
  {
    kz: '4170',
    label: 'Steuerfreie Umsätze (§4 UStG / igL / Ausfuhr)',
    // igL = reverseCharge invoices on the seller
    // side (delivery within the EU to a B2B
    // customer — the buyer accounts for VAT under
    // §13b). The seller's revenue is steuerfrei.
    matcher: (inv) => inv.reverseCharge === true,
  },
  {
    kz: '4190',
    label: 'Sonstige Betriebseinnahmen',
    // Anything with revenue that doesn't match
    // the above. Filled in last.
    matcher: () => false, // fallback bucket
  },
]

const EXPENSE_LINES: Array<{ kz: string; label: string; matcher: (exp: any) => boolean }> = [
  {
    kz: '4300',
    label: 'Wareneinsatz (Material, Hilfsstoffe)',
    matcher: (exp) => /^(Material|Waren|Rohstoffe?)/i.test(exp.category || ''),
  },
  {
    kz: '5100',
    label: 'Personalkosten (Löhne, Gehälter)',
    matcher: (exp) => /^(Personal|Lohn|Gehalt|SV)/i.test(exp.category || ''),
  },
  {
    kz: '5400',
    label: 'Raumkosten (Miete, Nebenkosten, Heizung)',
    matcher: (exp) => /^(Miete|Raum|Heizung|Nebenkosten)/i.test(exp.category || ''),
  },
  {
    kz: '5600',
    label: 'Werbe- und Reisekosten',
    matcher: (exp) => /^(Werbung|Marketing|Reise|Bewirtung)/i.test(exp.category || ''),
  },
  {
    kz: '5800',
    label: 'Instandhaltung, EDV, Werkzeuge',
    matcher: (exp) => /^(EDV|Instandhaltung|Werkzeug|Reparatur)/i.test(exp.category || ''),
  },
  {
    kz: '5900',
    label: 'Sonstige Aufwendungen (Büro, Porto, Versicherung)',
    matcher: () => false, // fallback
  },
]

@Injectable()
export class EuerService {
  constructor(private prisma: PrismaService) {}

  async compute(companyId: string, year: number): Promise<EuerResult> {
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)

    // Pull every invoice in the year (any status
    // that contributed to revenue). Drafts are
    // excluded — they're not billable yet.
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: yearStart, lte: yearEnd },
        status: { in: ['paid', 'sent', 'overdue'] },
      },
      select: {
        subtotal: true,
        totalVat: true,
        // Invoice has a single `reverseCharge`
        // boolean (the seller-side flag — true for
        // igL + §13b cases). intra-EU purchases on
        // the buyer's side (igE) live on Expense.
        reverseCharge: true,
      },
    })
    // Same approach for expenses.
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: yearStart, lte: yearEnd },
        status: { in: ['booked', 'deductible'] },
      },
      select: {
        netAmount: true,
        category: true,
      },
    })

    // Bucket revenues by Kennziffer. The matchers
    // are evaluated in order; the first match wins.
    // "Sonstige Betriebseinnahmen" is the fallback
    // (matcher always returns false), so anything
    // not matched lands there.
    //
    // Credit notes (Gutschriften — subtotal < 0)
    // always reduce Kz 4100, because the BMF
    // Anlage EÜR convention is to show them on
    // the same line as the original Umsatzerlöse,
    // not as a separate "sonstige" entry. The
    // original invoice was almost certainly
    // USt-pflichtig (this is the default for B2B
    // sales in de-invoice), so subtracting from
    // 4100 is the conservative choice. If the
    // original was actually Kz 4120/4170 the
    // net is still correct on a Steuerberater
    // review.
    const einnahmenBuckets = new Map<string, number>()
    for (const def of REVENUE_LINES) einnahmenBuckets.set(def.kz, 0)
    for (const inv of invoices) {
      const subtotal = Number(inv.subtotal)
      if (subtotal < 0) {
        // Gutschrift — offset Kz 4100 (negative)
        einnahmenBuckets.set('4100', (einnahmenBuckets.get('4100') || 0) + subtotal)
        continue
      }
      const matched = REVENUE_LINES.find((d) => d.matcher(inv))
      const kz = matched?.kz || '4190'
      einnahmenBuckets.set(kz, (einnahmenBuckets.get(kz) || 0) + subtotal)
    }

    const ausgabenBuckets = new Map<string, number>()
    for (const def of EXPENSE_LINES) ausgabenBuckets.set(def.kz, 0)
    for (const exp of expenses) {
      const matched = EXPENSE_LINES.find((d) => d.matcher(exp))
      const kz = matched?.kz || '5900'
      ausgabenBuckets.set(kz, (ausgabenBuckets.get(kz) || 0) + Number(exp.netAmount))
    }

    // Build the final lines in the order the BMF
    // uses (so the PDF/UI reads top-to-bottom in
    // the right order).
    const einnahmen: EuerLine[] = REVENUE_LINES.map((d) => ({
      kennziffer: d.kz,
      label: d.label,
      amount: Math.round((einnahmenBuckets.get(d.kz) || 0) * 100) / 100,
    }))
    const ausgaben: EuerLine[] = EXPENSE_LINES.map((d) => ({
      kennziffer: d.kz,
      label: d.label,
      amount: Math.round((ausgabenBuckets.get(d.kz) || 0) * 100) / 100,
    }))

    const einnahmenTotal = einnahmen.reduce((s, l) => s + l.amount, 0)
    const ausgabenTotal = ausgaben.reduce((s, l) => s + l.amount, 0)
    const gewinn = Math.round((einnahmenTotal - ausgabenTotal) * 100) / 100

    return {
      year,
      companyId,
      einnahmen,
      ausgaben,
      totals: {
        einnahmenTotal: Math.round(einnahmenTotal * 100) / 100,
        ausgabenTotal: Math.round(ausgabenTotal * 100) / 100,
        gewinn,
      },
      counts: {
        invoices: invoices.length,
        expenses: expenses.length,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihren Buchungen generiert. ' +
        'Bitte vor der Einreichung vom Steuerberater prüfen lassen — die ' +
        'Kategorie-Zuordnung folgt einer heuristischen Wort-Matching-Regel ' +
        'und kann in Einzelfällen abweichen.',
    }
  }

  /**
   * Render the EÜR as a GoBD-style A4 PDF. Single
   * page for small businesses, multi-page for
   * bigger ones. Same German typography as the
   * voucher-PDF.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-EUR-${year}.pdf"`,
    )
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    doc.pipe(res)
    this.renderEurBody(doc, data, company)
    doc.end()
  }

  /**
   * Tier 85: render the EÜR PDF as a Buffer
   * (for ZIP packaging — see
   * BeraterPackagerService). The body is
   * shared with renderPdf via the
   * renderEurBody helper.
   */
  async renderBuffer(companyId: string, year: number): Promise<Buffer> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks: Buffer[] = []
    const sink = new (require('stream').Writable)({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        chunks.push(chunk)
        cb()
      },
    })
    doc.pipe(sink)
    this.renderEurBody(doc, data, company)
    doc.end()
    return new Promise<Buffer>((resolve, reject) => {
      sink.on('finish', () => resolve(Buffer.concat(chunks)))
      sink.on('error', reject)
    })
  }

  private renderEurBody(
    doc: PDFKit.PDFDocument,
    data: any,
    company: any,
  ): void {
    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage EÜR ${data.year}`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(`Einnahmen-Überschuss-Rechnung ${data.year}`)
      .text(`${company?.name || ''}`)
      .moveDown(0.5)

    // Einnahmen
    doc.fontSize(12).font('Helvetica-Bold').text('Betriebseinnahmen')
    doc.fontSize(9).font('Helvetica')
    for (const l of data.einnahmen) {
      const y = doc.y
      doc.text(l.kennziffer, 50, y, { continued: true, width: 50 })
      doc.text(l.label, 100, y, { continued: true, width: 320 })
      doc.text(this.fmtEur(l.amount), 420, y, { width: 125, align: 'right' })
      doc.moveDown(0.1)
    }
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold')
    doc.text('Summe Einnahmen', 100, doc.y, { continued: true, width: 320 })
    doc.text(this.fmtEur(data.totals.einnahmenTotal), 420, doc.y, { width: 125, align: 'right' })
    doc.moveDown(0.5)

    // Ausgaben
    doc.font('Helvetica-Bold').fontSize(12).text('Betriebsausgaben')
    doc.font('Helvetica').fontSize(9)
    for (const l of data.ausgaben) {
      const y = doc.y
      doc.text(l.kennziffer, 50, y, { continued: true, width: 50 })
      doc.text(l.label, 100, y, { continued: true, width: 320 })
      doc.text(this.fmtEur(l.amount), 420, y, { width: 125, align: 'right' })
      doc.moveDown(0.1)
    }
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold')
    doc.text('Summe Ausgaben', 100, doc.y, { continued: true, width: 320 })
    doc.text(this.fmtEur(data.totals.ausgabenTotal), 420, doc.y, { width: 125, align: 'right' })
    doc.moveDown(0.5)

    // Gewinn/Verlust
    const isProfit = data.totals.gewinn >= 0
    doc.fontSize(12)
    doc.fillColor(isProfit ? '#047857' : '#b91c1c')
    doc.text(
      isProfit
        ? `Gewinn: ${this.fmtEur(data.totals.gewinn)} EUR`
        : `Verlust: ${this.fmtEur(Math.abs(data.totals.gewinn))} EUR`,
    )
    doc.fillColor('#000')
    doc.moveDown(0.5)

    // Disclaimer
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666')
    doc.text(data.disclaimer, { width: 495 })
    doc.fillColor('#000')

    // Footer
    doc.fontSize(7).font('Helvetica').fillColor('#999')
    doc.text(
      `Erstellt: ${new Date(data.generatedAt).toLocaleString('de-DE')}  |  ` +
        `Rechnungen: ${data.counts.invoices}  |  Ausgaben: ${data.counts.expenses}  |  ` +
        `de-invoice · Anlage EÜR`,
      { align: 'center' },
    )
    doc.fillColor('#000')
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: EuerLine[],
    total: number,
  ): void {
    const tableTop = doc.y
    const colKz = 50
    const colLabel = 60
    const colAmount = 350

    // Header
    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Kz', colKz, tableTop, { continued: true })
    doc.text('Bezeichnung', colKz + 35, tableTop, { continued: true })
    doc.text('Betrag (€)', colAmount, tableTop, { width: 145, align: 'right' })
    doc.moveDown(0.3)

    // Body
    doc.font('Helvetica')
    for (const l of lines) {
      const y = doc.y
      doc.fontSize(10)
      doc.text(l.kennziffer, colKz, y)
      doc.text(l.label, colKz + 35, y, { width: 280 })
      doc.text(this.fmtEur(l.amount), colAmount, y, { width: 145, align: 'right' })
      doc.moveDown(0.3)
    }

    // Total
    doc.moveTo(colKz, doc.y).lineTo(495, doc.y).stroke()
    doc.moveDown(0.2)
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text('Summe', colKz + 35, doc.y, { width: 280 })
    doc.text(this.fmtEur(total), colAmount, doc.y, { width: 145, align: 'right' })
  }

  private fmtEur(n: number): string {
    // German number format: 1.234,56
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }
}
