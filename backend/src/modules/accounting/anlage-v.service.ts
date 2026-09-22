import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'
import { invoiceNetRevenue } from '../invoice/tax-breakdown';
import { SALES_TYPES } from '../invoice/document-scope'

/**
 * Tier 92: Anlage V — Einkünfte aus Vermietung
 * und Verpachtung (§ 21 EStG).
 *
 * The German tax filing for landlords /
 * Vermieter: a year-end attachment to the
 * Einkommensteuererklärung. Pairs with Anlage
 * S (freelancer) and Anlage G (Gewerbe) — same
 * BMF form family, different Einkunftsart.
 *
 * Three big-picture differences from Anlage S
 * / EÜR:
 *   1. The expense side uses "Werbungskosten"
 *      (instead of "Betriebsausgaben") — the
 *      term is legally distinct for § 21 EStG.
 *      The Kennziffern in this Anlage V file
 *      are STILL labelled "Werbungskosten" to
 *      match the BMF form vocabulary.
 *   2. The dominant Werbungskosten categories
 *      are different: Schuldzinsen, Grundsteuer,
 *      Gebäude-AfA, Gebäudeversicherung,
 *      Hausverwaltung. NOT the typical freelance
 *      / Gewerbe categories (Kfz, Fortbildung,
 *      Material, etc.).
 *   3. The 4600 / 8600 line (AfA) is the
 *      single largest line for most landlords —
 *      a typical 300k EUR apartment depreciated
 *      over 50y = 6000 EUR/year AfA. This is
 *      where the booking matters most.
 *
 * v1 heuristic: ALL paid/sent/overdue invoices
 * in the year are treated as Mieteinnahmen. The
 * opt-in flag `Company.settings.anlageV ===
 * true` gates whether the report is generated
 * at all (the user enables Anlage V on a
 * per-company basis when the company is a
 * Vermieter). v2 could add per-customer /
 * per-asset tagging for mixed-use companies.
 *
 * Output: per-Kennziffer lines + per-side
 * subtotals + Überschuss/Verlust. Same VORSCHAU
 * (preview) caveat as EÜR / Anlage S — the
 * disclaimer surfaces in the response + the PDF
 * footer.
 *
 * The Kennziffern 8100-8900 are an internal
 * namespace (not BMF's actual Zeile numbers in
 * the printable Anlage V form). The Berater
 * maps them to the BMF Zeile positions when
 * transcribing the VORSCHAU into the actual
 * ElsterForm / PDF form.
 */
export interface AnlageVLine {
  kennziffer: string
  label: string
  amount: number
}

export interface AnlageVResult {
  year: number
  companyId: string
  einnahmen: AnlageVLine[]
  werbungskosten: AnlageVLine[]
  totals: {
    einnahmenTotal: number
    werbungskostenTotal: number
    ueberschuss: number // einnahmen - werbungskosten (positive = profit, negative = Verlust)
  }
  counts: {
    invoices: number
    expenses: number
    afaBookings: number
    buildingAssets: number
  }
  afaSource: 'booked' | 'computed' | 'nicht_gebucht'
  generatedAt: string
  disclaimer: string
}

// Tier 92: Anlage V revenue Kennziffern 8100-8190.
// v1 uses the same VAT-status matchers as Anlage S
// (4100 = USt-pflichtig, 4120 = § 19 UStG, 4135 =
// steuerfrei). The 8190 fallback catches anything
// the matchers miss.
const REVENUE_LINES: Array<{ kz: string; label: string; matcher: (inv: any) => boolean }> = [
  {
    kz: '8100',
    label: 'Mieteinnahmen (umsatzsteuerpflichtig)',
    matcher: (inv) => Number(inv.totalVat) > 0,
  },
  {
    kz: '8120',
    label: 'Mieteinnahmen nach § 19 UStG (Kleinunternehmer)',
    matcher: (inv) => Number(inv.totalVat) === 0 && Number(inv.subtotal) > 0,
  },
  {
    kz: '8135',
    label: 'Steuerfreie Vermietungseinnahmen (igL / Ausfuhr)',
    matcher: (inv) => inv.reverseCharge === true,
  },
  {
    kz: '8190',
    label: 'Sonstige Mieteinnahmen (Umlagen, Kautionen-Zinsen)',
    matcher: () => false, // fallback
  },
]

// Tier 92: Anlage V Werbungskosten 8600-8890.
// Vermietung-spezifische Kategorien. We reuse
// the same "category" string conventions as
// Anlage S (free-text on Expense.category) so
// the user's existing categorization carries
// over. A landlord tagging an expense as
// "Schuldzinsen" gets it in the right bucket
// here AND in Anlage S / EÜR.
const EXPENSE_LINES: Array<{ kz: string; label: string; matcher: (exp: any) => boolean }> = [
  {
    kz: '8600',
    label: 'AfA auf Gebäude / Gebäudeteile (linear / degressiv)',
    matcher: () => false, // signal via AfA booking, not category match
  },
  {
    kz: '8610',
    label: 'Sofortabschreibungen GWG (geringwertige Wirtschaftsgüter)',
    matcher: () => false, // no GWG field in our schema
  },
  {
    kz: '8620',
    label: 'Schuldzinsen (Darlehen für Mietobjekte)',
    matcher: (exp) => /^(Schuldzins|Zins|Darlehen)/i.test(exp.category || ''),
  },
  {
    kz: '8630',
    label: 'Grundsteuer',
    matcher: (exp) => /^(Grundsteuer)/i.test(exp.category || ''),
  },
  {
    kz: '8640',
    label: 'Gebäudeversicherung (Wohngebäude-, Haftpflicht-, Glasversicherung)',
    matcher: (exp) => /^(Gebäude|Haus|Wohngebäude|Haftpflicht)/i.test(exp.category || ''),
  },
  {
    kz: '8650',
    label: 'Hausverwaltung, Mieterverein, Makler',
    matcher: (exp) => /^(Hausverwaltung|Mieterverein|Makler)/i.test(exp.category || ''),
  },
  {
    kz: '8660',
    label: 'Reparaturen / Instandhaltung (keine Herstellungs-/Erhaltungsaufwand)',
    matcher: (exp) => /^(Reparatur|Instandhaltung|Wartung)/i.test(exp.category || ''),
  },
  {
    kz: '8670',
    label: 'Nebenkosten (Müllabfuhr, Schornsteinfeger, Treppenhausreinigung)',
    matcher: (exp) => /^(Nebenkosten|Müll|Schornstein|Treppenhaus|Aufzug)/i.test(exp.category || ''),
  },
  {
    kz: '8690',
    label: 'Übrige Werbungskosten',
    matcher: () => false, // fallback
  },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class AnlageVService {
  constructor(private prisma: PrismaService) {}

  /**
   * Compute the Anlage V for the year. Returns
   * the report JSON. The controller wraps this
   * in the year-defaults + auth handling.
   *
   * v1: ALL paid/sent/overdue invoices in the
   * year are treated as Mieteinnahmen. The
   * opt-in flag is on the controller (not
   * here) — this method just computes from
   * the data.
   */
  async compute(companyId: string, year: number): Promise<AnlageVResult> {
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)

    // Pull every invoice in the year (any status
    // that contributed to revenue). Drafts are
    // excluded — they're not billable yet.
    // v1: no per-customer filtering. The user
    // opts in via Company.settings.anlageV ===
    // true on the controller side, which gates
    // whether the report is generated at all.
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: yearStart, lte: yearEnd },
        status: { in: ['paid', 'sent', 'overdue'] },
        type: { in: SALES_TYPES }, // Tier 424: not a Proforma
      },
      select: {
        subtotal: true,
        totalVat: true,
        // Tier 411: revenue is total − totalVat (after the discount), in EUR.
        total: true,
        eurTotal: true,
        eurTotalVat: true,
        reverseCharge: true,
      },
    })

    // Werbungskosten (Expense rows). Tier 87/89:
    // exclude booked AfA rows from the Sonstige
    // fallback — they go to 8600 via the explicit
    // AfA booking query below.
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: yearStart, lte: yearEnd },
        status: { in: ['booked', 'deductible'] },
        category: { not: 'AfA' },
      },
      select: {
        netAmount: true,
        category: true,
      },
    })

    // Booked AfA for 8600. Pulled separately
    // because 8600's matcher is a stub — the
    // booking is a SIGNAL not a category match.
    // We sum the |netAmount| (negative) and
    // surface it as the 8600 line.
    const bookedAfa = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: yearStart, lte: yearEnd },
        category: 'AfA',
        afaYear: year,
        relatedAssetId: { not: null },
      },
      select: { netAmount: true, relatedAssetId: true },
    })
    const bookedAfaSum = bookedAfa.reduce(
      (s, e) => s.plus(e.netAmount ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    ).toNumber()

    // Building assets for the AfA-source fallback.
    // When no booking exists, we use the in-memory
    // computed AfA (AssetsService.computeAfA logic
    // re-implemented here to avoid a circular
    // import — AssetsService is in another module).
    // v1 simplification: only count assets where
    // type ∈ {Grundstueck, Gebaeude} (the rental
    // pool). Other types (Maschine, Fahrzeug) are
    // irrelevant for Anlage V.
    const buildingAssets = await this.prisma.asset.findMany({
      where: {
        companyId,
        type: { in: ['Grundstueck', 'Gebaeude'] },
      },
      select: {
        id: true,
        anschaffungsKosten: true,
        restwert: true,
        nutzungsdauerMonate: true,
        anschaffungsDatum: true,
        verkauftAm: true,
      },
    })
    const computedAfaSum = buildingAssets.reduce(
      (s, a) => s + this.computeAfaForYear(a, year),
      0,
    )

    // Bucket revenues by Kennziffer.
    const einnahmenBuckets = new Map<string, number>()
    for (const def of REVENUE_LINES) einnahmenBuckets.set(def.kz, 0)
    for (const inv of invoices) {
      // Tier 411: after the invoice discount, in EUR (see anlage-s).
      const subtotal = invoiceNetRevenue(inv)
      if (subtotal < 0) {
        // Gutschrift (CN) — same convention as
        // tier 76 EÜR / tier 80 Anlage S: offset
        // Kz 8100 directly. The BMF Anlage V is
        // symmetric to Anlage S here — the
        // original revenue line is reduced, not
        // a "sonstige" entry.
        einnahmenBuckets.set('8100', (einnahmenBuckets.get('8100') || 0) + subtotal)
        continue
      }
      const matched = REVENUE_LINES.find((d) => d.matcher(inv))
      const kz = matched?.kz || '8190'
      einnahmenBuckets.set(kz, (einnahmenBuckets.get(kz) || 0) + subtotal)
    }

    const werbungskostenBuckets = new Map<string, number>()
    for (const def of EXPENSE_LINES) werbungskostenBuckets.set(def.kz, 0)
    for (const exp of expenses) {
      const matched = EXPENSE_LINES.find((d) => d.matcher(exp))
      const kz = matched?.kz || '8690'
      werbungskostenBuckets.set(kz, (werbungskostenBuckets.get(kz) || 0) + Number(exp.netAmount))
    }

    // Build the final lines in the BMF order.
    const einnahmen: AnlageVLine[] = REVENUE_LINES.map((d) => ({
      kennziffer: d.kz,
      label: d.label,
      amount: round2(einnahmenBuckets.get(d.kz) || 0),
    }))
    const werbungskosten: AnlageVLine[] = EXPENSE_LINES.map((d) => {
      // 8600 AfA: prefer booked sum (more
      // accurate — reflects real postings).
      // Fall back to computed if no booking
      // exists. If both are 0, the line is
      // 0 + the disclaimer flags it as
      // "nicht gebucht".
      if (d.kz === '8600') {
        if (bookedAfa.length > 0) {
          return {
            kennziffer: d.kz,
            label: d.label,
            amount: round2(bookedAfaSum),
          }
        }
        return {
          kennziffer: d.kz,
          label: d.label,
          amount: round2(-Math.abs(computedAfaSum)),
        }
      }
      return {
        kennziffer: d.kz,
        label: d.label,
        amount: round2(werbungskostenBuckets.get(d.kz) || 0),
      }
    })

    const einnahmenTotal = einnahmen.reduce((s, l) => s + l.amount, 0)
    const werbungskostenTotal = werbungskosten.reduce((s, l) => s + l.amount, 0)
    const ueberschuss = round2(einnahmenTotal - werbungskostenTotal)

    return {
      year,
      companyId,
      einnahmen,
      werbungskosten,
      totals: {
        einnahmenTotal: round2(einnahmenTotal),
        werbungskostenTotal: round2(werbungskostenTotal),
        ueberschuss,
      },
      counts: {
        invoices: invoices.length,
        expenses: expenses.length,
        afaBookings: bookedAfa.length,
        buildingAssets: buildingAssets.length,
      },
      // 8600 is "gebucht" if a booking exists,
      // "computed" if we fell back to the in-
      // memory computation, "nicht_gebucht"
      // if no building assets exist.
      afaSource:
        bookedAfa.length > 0
          ? 'booked'
          : buildingAssets.length > 0
            ? 'computed'
            : 'nicht_gebucht',
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihren Buchungen generiert. ' +
        'Anlage V ist für Einkünfte aus Vermietung und Verpachtung (§ 21 EStG) — ' +
        'bei mehreren Mietobjekten mit unterschiedlichen AfA-Bemessungsgrundlagen ' +
        'ergänzen Sie die Anlage V Zeile 31+ manuell. Bitte vor der Einreichung ' +
        'vom Steuerberater prüfen lassen.',
    }
  }

  /**
   * Render the Anlage V as a GoBD-style A4 PDF.
   * Same layout as Anlage S: header + two
   * tables (Einnahmen + Werbungskosten) +
   * Überschuss/Verlust total + disclaimer +
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
      `attachment; filename="Anlage-V-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage V ${year}`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Einkünfte aus Vermietung und Verpachtung (§ 21 EStG) — ${company?.name || companyId}`,
      )
      .moveDown(1)

    // Einnahmen block
    doc.fontSize(12).font('Helvetica-Bold').text('Einnahmen')
    doc.moveDown(0.3)
    this.renderTable(doc, data.einnahmen, data.totals.einnahmenTotal)
    doc.moveDown(0.8)

    // Werbungskosten block
    doc.fontSize(12).font('Helvetica-Bold').text('Werbungskosten')
    doc.moveDown(0.3)
    this.renderTable(doc, data.werbungskosten, data.totals.werbungskostenTotal)
    doc.moveDown(0.8)

    // Überschuss/Verlust — same red/green as
    // EÜR / Anlage S. Positive = Überschuss
    // (the typical landlord case), negative =
    // Verlust (e.g. early years with high
    // Schuldzinsen + AfA, low Mieteinnahmen).
    doc.fontSize(14).font('Helvetica-Bold')
    const result = data.totals.ueberschuss
    doc
      .fillColor(result >= 0 ? '#047857' : '#b91c1c')
      .text(
        result >= 0
          ? `Überschuss: ${this.fmtEur(result)} €`
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
          `AfA-Buchungen: ${data.counts.afaBookings}  |  ` +
          `Mietobjekte: ${data.counts.buildingAssets}  |  ` +
          `de-invoice · Anlage V Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  /**
   * Compute the AfA for one asset at year-end
   * snapshot (Dec 31, 23:59:59.999). Linear
   * AfA only in v1. Mirrors the logic in
   * AssetsService.computeAfA — duplicated
   * here to avoid a cross-module dependency.
   *
   * Returns the negative amount (Werbungskosten
   * is a positive expense line in the report,
   * but stored as netAmount = -amount on
   * Expense rows). For the COMPUTED fallback
   * (no booking), we surface the negative
   * number directly so the Anlage V Werbungs-
   * kosten sum works the same as for booked.
   */
  private computeAfaForYear(
    asset: {
      anschaffungsKosten: any
      restwert: any
      nutzungsdauerMonate: number
      anschaffungsDatum: Date
      verkauftAm: Date | null
    },
    year: number,
  ): number {
    const ak = Number(asset.anschaffungsKosten)
    const restwert = Number(asset.restwert)
    const nd = asset.nutzungsdauerMonate
    if (nd <= 0) return 0
    const depreciable = Math.max(0, ak - restwert)
    const monthlyAfA = depreciable / nd

    // Snapshot = Dec 31 of the year
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)
    // Effective end: disposal if before year-end
    const effectiveEnd =
      asset.verkauftAm && asset.verkauftAm <= yearEnd
        ? asset.verkauftAm
        : yearEnd

    // Year-to-charge window: max(asset
    // acquisition, year start) → min(asset
    // disposal, year end). Months in window
    // are the count of full months the asset
    // was held in the year.
    const yearStart = new Date(year, 0, 1)
    const start = asset.anschaffungsDatum > yearStart ? asset.anschaffungsDatum : yearStart
    const end = effectiveEnd
    if (start > end) return 0

    // Full months in window
    const months = this.diffMonths(start, end)
    // Cap at remaining ND
    const monthsAlreadyAtStart = this.diffMonths(asset.anschaffungsDatum, yearStart)
    const remainingNd = Math.max(0, nd - monthsAlreadyAtStart)
    const monthsInYear = Math.min(months, remainingNd)
    return round2(-Math.abs(monthsInYear * monthlyAfA))
  }

  private diffMonths(from: Date, to: Date): number {
    if (to < from) return 0
    const y = to.getFullYear() - from.getFullYear()
    const m = to.getMonth() - from.getMonth()
    let total = y * 12 + m
    if (to.getDate() >= from.getDate()) total += 1
    return Math.max(0, total)
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: AnlageVLine[],
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
