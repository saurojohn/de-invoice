import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 80: Anlage S — Einkünfte aus
 * selbständiger Arbeit (§ 18 EStG).
 *
 * The German tax filing for freelancers /
 * Selbständige: a year-end attachment to the
 * Einkommensteuererklärung. The BMF Kennziffern
 * 4100-4900 (Anlage S) are a SUPERSET of the
 * EÜR 4100-5900 (Anlage EÜR) — same revenue
 * structure, but the expense side focuses on
 * the typical freelance deductible categories
 * (Kfz, Fortbildung, Steuerberatung, etc.)
 * instead of the typical Gewerbe categories
 * (Rohstoffe, Werkzeuge, Werkstatt).
 *
 * Three big-picture differences from EÜR:
 *   1. EÜR is for Gewerbebetrieb (§ 15 EStG);
 *      Anlage S is for selbständige Arbeit
 *      (§ 18 EStG) — typically freelancers
 *      (Beratung, IT, Journalismus, Heilberufe).
 *   2. The § 18 EStG side of the EStG has a
 *      'Werbungskosten' concept (vs. the EÜR's
 *      'Betriebsausgaben'). The Kennziffern
 *      in this Anlage S file are STILL called
 *      Betriebsausgaben because that's what
 *      the BMF form uses — the tax-code
 *      distinction is irrelevant to the line
 *      numbers.
 *   3. The CN-Offsets convention from EÜR
 *      (Gutschriften reduce Kz 4100 directly)
 *      also applies here. We share the same
 *      tier 76 logic.
 *
 * Output: per-Kennziffer lines + per-side
 * subtotals + Gewinn/Verlust. Same VORSCHAU
 * (preview) caveat as EÜR — the disclaimer
 * surfaces in the response + the PDF footer.
 */
export interface AnlageSLine {
  kennziffer: string
  label: string
  amount: number
}

export interface AnlageSResult {
  year: number
  companyId: string
  einnahmen: AnlageSLine[]
  ausgaben: AnlageSLine[]
  totals: {
    einnahmenTotal: number
    ausgabenTotal: number
    gewinn: number // einnahmen - ausgaben (positive = profit, negative = loss)
  }
  counts: {
    invoices: number
    expenses: number
    // Tier 87: how many AfA-Buchung rows
    // for this year (one per Asset that
    // was booked into 4600).
    afaBookings: number
  }
  // Tier 87: 'booked' if AfA-Buchung rows
  // exist for this year (4600 has a real
  // value). 'nicht_gebucht' if no booking
  // has been made (4600 stays at 0).
  afaSource: 'booked' | 'nicht_gebucht'
  generatedAt: string
  disclaimer: string
}

// BMF Anlage S 2026 Kennziffern. The 4600-range
// lines are the typical freelance deductible
// categories; the 4100-range mirrors the EÜR
// revenue structure.
const REVENUE_LINES: Array<{ kz: string; label: string; matcher: (inv: any) => boolean }> = [
  {
    kz: '4100',
    label: 'Umsatzerlöse (umsatzsteuerpflichtig)',
    matcher: (inv) => Number(inv.totalVat) > 0,
  },
  {
    kz: '4120',
    label: 'Umsatzerlöse nach § 19 UStG (Kleinunternehmer)',
    matcher: (inv) => Number(inv.totalVat) === 0 && Number(inv.subtotal) > 0,
  },
  {
    kz: '4135',
    label: 'Steuerfreie Umsätze nach § 4 UStG / igL / Ausfuhr',
    matcher: (inv) => inv.reverseCharge === true,
  },
  {
    kz: '4170',
    label: 'Sonstige steuerfreie Betriebseinnahmen',
    matcher: () => false, // placeholder
  },
  {
    kz: '4190',
    label: 'Sonstige Betriebseinnahmen',
    matcher: () => false, // fallback
  },
]

const EXPENSE_LINES: Array<{ kz: string; label: string; matcher: (exp: any) => boolean }> = [
  {
    kz: '4600',
    label: 'AfA / Abschreibungen auf Sachanlagen',
    matcher: () => false, // no AfA line in our schema yet
  },
  {
    kz: '4610',
    label: 'Sofortabschreibungen GWG (geringwertige Wirtschaftsgüter)',
    matcher: () => false, // no GWG field in our schema
  },
  {
    kz: '4620',
    label: 'Fremdleistungen / Materialeinsatz',
    matcher: (exp) => /^(Material|Waren|Rohstoffe?|Fremdleistung)/i.test(exp.category || ''),
  },
  {
    kz: '4630',
    label: 'Personalkosten (Löhne, Gehälter, SV)',
    matcher: (exp) => /^(Personal|Lohn|Gehalt|SV)/i.test(exp.category || ''),
  },
  {
    kz: '4640',
    label: 'Raumkosten (Miete, Pacht, Nebenkosten, Heizung)',
    matcher: (exp) => /^(Miete|Raum|Heizung|Nebenkosten|Pacht)/i.test(exp.category || ''),
  },
  {
    kz: '4650',
    label: 'Versicherungen, Beiträge (außer Kfz)',
    matcher: (exp) => /^(Versicherung|Beitrag)/i.test(exp.category || ''),
  },
  {
    kz: '4660',
    label: 'Kfz-Kosten',
    matcher: (exp) => /^(Kfz|KFZ|Auto|Fahrzeug|Tankstelle|Benzin)/i.test(exp.category || ''),
  },
  {
    kz: '4670',
    label: 'Werbung, Reise, Bewirtung',
    matcher: (exp) => /^(Werbung|Marketing|Reise|Bewirtung|Tank)/i.test(exp.category || ''),
  },
  {
    kz: '4680',
    label: 'Fortbildung, Fachliteratur',
    matcher: (exp) => /^(Fortbildung|Fachliteratur|Buch)/i.test(exp.category || ''),
  },
  {
    kz: '4690',
    label: 'Telefon, Internet, Porto, Büromaterial',
    matcher: (exp) => /^(Telefon|Internet|Porto|B[üu]ro|Bürobedarf)/i.test(exp.category || ''),
  },
  {
    kz: '4700',
    label: 'Steuerberatung, Rechtsberatung, Notar',
    matcher: (exp) => /^(Steuerberatung|Rechtsberatung|Notar|Anwalt)/i.test(exp.category || ''),
  },
  {
    kz: '4710',
    label: 'Schuldzinsen',
    matcher: (exp) => /^(Schuldzins|Zins)/i.test(exp.category || ''),
  },
  {
    kz: '4720',
    label: 'Übrige / Sonstige Betriebsausgaben',
    matcher: () => false, // fallback
  },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class AnlageSService {
  constructor(private prisma: PrismaService) {}

  async compute(companyId: string, year: number): Promise<AnlageSResult> {
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
        reverseCharge: true,
      },
    })
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: yearStart, lte: yearEnd },
        status: { in: ['booked', 'deductible'] },
        // Tier 87: booked AfA rows are
        // excluded here and surfaced in
        // the 4600 line via the explicit
        // AfA-Buchung query below. Without
        // this exclusion they would fall
        // through to the 4720 "Übrige"
        // fallback and double-count.
        category: { not: 'AfA' },
      },
      select: {
        netAmount: true,
        category: true,
      },
    })

    // Tier 87: AfA-Buchung rows for 4600. Pulled
    // separately because the EXPENSE_LINES matcher
    // for 4600 is a stub (returns false) — the
    // booked AfA is a SIGNAL not a category match.
    // We sum the netAmount (= -annualAfA, negative
    // reduces profit) and write it to 4600 below.
    const bookedAfa = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: yearStart, lte: yearEnd },
        category: 'AfA',
        afaYear: year,
        relatedAssetId: { not: null },
      },
      select: { netAmount: true },
    })
    const bookedAfaSum = bookedAfa.reduce(
      (s, e) => s.plus(e.netAmount ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    ).toNumber()

    // Bucket revenues by Kennziffer. The
    // matchers are evaluated in order; the first
    // match wins. "Sonstige Betriebseinnahmen"
    // is the fallback.
    const einnahmenBuckets = new Map<string, number>()
    for (const def of REVENUE_LINES) einnahmenBuckets.set(def.kz, 0)
    for (const inv of invoices) {
      const subtotal = Number(inv.subtotal)
      if (subtotal < 0) {
        // Gutschrift (CN) — same convention as
        // tier 76 EÜR: offset Kz 4100 directly.
        // The BMF Anlage S is symmetric to EÜR
        // here — the original revenue line is
        // reduced, not a "sonstige" entry.
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
      const kz = matched?.kz || '4720'
      ausgabenBuckets.set(kz, (ausgabenBuckets.get(kz) || 0) + Number(exp.netAmount))
    }

    // Build the final lines in the order the
    // BMF uses.
    const einnahmen: AnlageSLine[] = REVENUE_LINES.map((d) => ({
      kennziffer: d.kz,
      label: d.label,
      amount: round2(einnahmenBuckets.get(d.kz) || 0),
    }))
    const ausgaben: AnlageSLine[] = EXPENSE_LINES.map((d) => {
      // Tier 87: 4600 AfA gets the booked AfA sum
      // (negative netAmount). If no booking exists
      // for this year, 4600 stays at 0 (the
      // computed-fallback path would require an
      // AssetsService import here; we keep v1
      // simple — the user opens Anlagenverzeichnis
      // and clicks "AfA buchen" to populate 4600).
      if (d.kz === '4600') {
        return {
          kennziffer: d.kz,
          label: d.label,
          amount: round2(bookedAfaSum),
        }
      }
      return {
        kennziffer: d.kz,
        label: d.label,
        amount: round2(ausgabenBuckets.get(d.kz) || 0),
      }
    })

    const einnahmenTotal = einnahmen.reduce((s, l) => s + l.amount, 0)
    const ausgabenTotal = ausgaben.reduce((s, l) => s + l.amount, 0)
    const gewinn = round2(einnahmenTotal - ausgabenTotal)

    return {
      year,
      companyId,
      einnahmen,
      ausgaben,
      totals: {
        einnahmenTotal: round2(einnahmenTotal),
        ausgabenTotal: round2(ausgabenTotal),
        gewinn,
      },
      counts: {
        invoices: invoices.length,
        expenses: expenses.length,
        // Tier 87: how many AfA bookings exist
        // for this year.
        afaBookings: bookedAfa.length,
      },
      // Tier 87: 4600 is "gebucht" if a booking
      // exists, else "nicht gebucht" (0).
      afaSource: bookedAfa.length > 0 ? 'booked' : 'nicht_gebucht',
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihren Buchungen generiert. ' +
        'Anlage S ist für Einkünfte aus selbständiger Arbeit (§ 18 EStG) — ' +
        'bei Verlustzuweisungen an Mitunternehmer / Personengesellschaften ' +
        'ergänzen Sie die Anlage SO. Bitte vor der Einreichung vom ' +
        'Steuerberater prüfen lassen.',
    }
  }

  /**
   * Render the Anlage S as a GoBD-style A4 PDF.
   * Same layout as the EÜR PDF: header +
   * two tables (Einnahmen + Ausgaben) +
   * Gewinn/Verlust total + disclaimer +
   * footer. Multi-page if the user has many
   * Kennziffern with values.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-S-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage S ${year}`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Einkünfte aus selbständiger Arbeit (§ 18 EStG) — ${company?.name || companyId}`,
      )
      .moveDown(1)

    // Einnahmen block
    doc.fontSize(12).font('Helvetica-Bold').text('Betriebseinnahmen')
    doc.moveDown(0.3)
    this.renderTable(doc, data.einnahmen, data.totals.einnahmenTotal)
    doc.moveDown(0.8)

    // Ausgaben block
    doc.fontSize(12).font('Helvetica-Bold').text('Betriebsausgaben')
    doc.moveDown(0.3)
    this.renderTable(doc, data.ausgaben, data.totals.ausgabenTotal)
    doc.moveDown(0.8)

    // Gewinn block — same red/green as EÜR.
    doc.fontSize(14).font('Helvetica-Bold')
    const result = data.totals.gewinn
    doc
      .fillColor(result >= 0 ? '#047857' : '#b91c1c')
      .text(
        result >= 0
          ? `Gewinn: ${this.fmtEur(result)} €`
          : `Verlust: ${this.fmtEur(Math.abs(result))} €`,
      )
      .fillColor('#000')
    doc.moveDown(1.5)

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
          `Rechnungen: ${data.counts.invoices}  |  Ausgaben: ${data.counts.expenses}  |  ` +
          `de-invoice · Anlage S Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: AnlageSLine[],
    total: number,
  ): void {
    const tableTop = doc.y
    const colKz = 50
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
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }
}
