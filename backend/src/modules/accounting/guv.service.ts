import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { AssetsService } from '../assets/assets.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 82: Anlage G+V (Gewinn- und Verlustrechnung).
 *
 * The formal § 275 HGB income statement that
 * pairs with the Bilanz for Bilanz-pflichtige
 * entities (GmbH, AG, etc.). Required as part
 * of the Jahresabschluss (§ 242 HGB).
 *
 * v1 honesty pattern (same as Bilanz, EÜR,
 * Anlage S): only compute what we can derive
 * from existing data. The rest is "nicht
 * ausgewiesen" (not stated) with explanatory
 * notes. The Berater completes the missing
 * positions before filing.
 *
 * Positions we DO compute in v1 (GKV — Gesamt-
 * kostenverfahren per § 275 Abs. 2 HGB, the
 * canonical German accounting layout):
 *
 *   Revenue:
 *     1.  Umsatzerlöse: signed Invoice subtotal
 *         (paid + sent + overdue) in the year.
 *         Gutschriften contribute negative.
 *     4.  Sonstige betriebliche Erträge: positive
 *         customer-credit overages (CustomerCredit-
 *         Transaction with type='overpayment' or
 *         'gutschrift' and amount > 0).
 *
 *   Cost:
 *     5.  Materialaufwand: Expense Material/Waren
 *         category, gross (Material + Kfz material
 *         parts — but for v1 just Material/Waren).
 *         We follow the Anlage S Kz 4620 mapping.
 *     6.  Personalaufwand: Expense Personal/Lohn
 *         category, gross. Same mapping as Anlage S
 *         Kz 4630.
 *     7.  Abschreibungen: NOT computed. No AfA
 *         tracking on the Anlagevermögen yet.
 *         User / Berater supplies from the
 *         Anlagenverzeichnis.
 *     8.  Sonstige betriebliche Aufwendungen:
 *         all OTHER expense categories (Miete,
 *         Versicherung, Werbung, Telefon, Steuer-
 *         beratung, etc.) per the Anlage S Kz
 *         4640-4720 mapping.
 *
 *   Financial result:
 *     13. Zinsen und ähnliche Aufwendungen:
 *         Expense Schuldzins category.
 *
 *   Result:
 *     17. Jahresüberschuss / Jahresfehlbetrag:
 *         computed: Betriebsleistung - 5-8 + 13
 *
 * v2 work (not in scope here):
 *   - AfA: requires Anlagevermögen tracking +
 *     depreciation schedule.
 *   - Beteiligungen + Wertpapiere: new model
 *     for investment income.
 *   - Zinserträge: separate model for
 *     Habenzinsen.
 *   - Steuern vom Einkommen und Ertrag:
 *     requires tax accrual tracking.
 *   - Bestandsveränderungen: requires inventory
 *     model.
 *
 * Pairing with Bilanz (tier 81):
 *   Jahresüberschuss (this report) =
 *     current year Bilanz Eigenkapital −
 *     prior year Bilanz Eigenkapital −
 *     dividends / capital movements
 *
 * In v1 the Bilanz exposes a Saldoposten that
 * already accommodates the Jahresüberschuss
 * (the Saldoposten is the residual that makes
 * the Bilanzgleichung balance). Together, the
 * two reports give the Mandant + Berater a
 * complete year-end picture.
 */

export interface GuVLine {
  position: string       // § 275 HGB position number, e.g. "1", "5a"
  label: string
  amount: number | null  // null = nicht ausgewiesen
  note?: string
}

export interface GuVSection {
  title: string
  lines: GuVLine[]
  subtotal: number | null
  nichtAusgewiesen: number
}

export interface GuVResult {
  year: number
  companyId: string
  // § 275 HGB GKV: Revenue → Cost → Operating result
  //                  → Financial result → Taxes → Jahresüberschuss
  revenue: GuVSection
  cost: GuVSection
  financial: GuVSection
  tax: GuVSection
  result: GuVSection
  totals: {
    umsatzerloese: number
    betriebsleistung: number
    betriebsergebnis: number
    finanzergebnis: number
    jahresueberschuss: number
  }
  counts: {
    invoices: number
    expenses: number
    credits: number
    // Tier 87: how many AfA-Buchung rows
    // for this year (one per Asset that
    // was booked into 7a).
    afaBookings: number
    assets: number
  }
  // Tier 87: 'booked' if AfA-Buchung rows
  // exist for this year (7a uses real
  // bookings). 'computed' if 7a uses the
  // in-memory Asset pool.
  afaSource: 'booked' | 'computed'
  generatedAt: string
  disclaimer: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class GuVService {
  constructor(
    private prisma: PrismaService,
    private assets: AssetsService,
  ) {}

  async compute(companyId: string, year: number): Promise<GuVResult> {
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)

    // ===== INVOICES (Umsatzerlöse) =====
    // Pull every invoice that contributed to
    // revenue in the year. Drafts are excluded
    // (not yet billable). Gutschriften contribute
    // negative because we use the SIGNED subtotal
    // (a Gutschrift's subtotal is stored as
    // negative, see EuerService for the same
    // pattern).
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: yearStart, lte: yearEnd },
        status: { in: ['paid', 'sent', 'overdue'] },
      },
      // Tier 118.5: G+V is a German BWA-style form
      // that sums everything in EUR. Pull the
      // pre-computed EUR equivalents alongside the
      // original-currency amounts.
      select: {
        subtotal: true,
        totalVat: true,
        eurSubtotal: true,
        eurTotalVat: true,
        reverseCharge: true,
      },
    })
    // Tier 118.5: aggregate in EUR. Prefer
    // eurSubtotal (pre-computed at issue time from
    // the ECB rate); fall back to the original
    // subtotal for legacy rows where the EUR
    // columns are still null.
    const umsatzerloese = invoices.reduce(
      (s, inv) =>
        s + (inv.eurSubtotal != null ? Number(inv.eurSubtotal) : Number(inv.subtotal)),
      0,
    )

    // ===== EXPENSES =====
    // Pull every booked/deductible expense in
    // the year. We bucket by category using the
    // same keyword matchers as AnlageSService
    // (4600-4720 Kennziffern) so the G+V cost
    // side stays consistent with what the
    // Anlage S / EÜR already show.
    //
    // Tier 87: booked AfA rows (category='AfA')
    // are excluded from this pull — they feed
    // into 7a Abschreibungen via a separate
    // query (and only when the user has clicked
    // "AfA buchen" for this year). Without this
    // exclusion the AfA rows would land in the
    // Sonstige bucket (8) and double-count.
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: yearStart, lte: yearEnd },
        status: { in: ['booked', 'deductible'] },
        category: { not: 'AfA' },
      },
      select: {
        netAmount: true,
        vatRate: true,
        vatAmount: true,
        grossAmount: true,
        category: true,
      },
    })

    // Tier 87: AfA-Buchung rows. Pulled separately
    // because they go straight to 7a Abschreibungen
    // (and only when present — the in-memory
    // computed value is the fallback when no
    // booking has been made).
    const bookedAfa = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: yearStart, lte: yearEnd },
        category: 'AfA',
        afaYear: year,
        relatedAssetId: { not: null },
      },
      select: { grossAmount: true },
    })
    const bookedAfASum = bookedAfa.reduce(
      (s, e) => s + Number(e.grossAmount),
      0,
    )
    const useBookedAfA = bookedAfASum !== 0

    // Bucket the expenses using Anlage S / EÜR
    // category matchers. The G+V groups them
    // differently (5a / 6a / 8 / 13) but the
    // matching logic is the same.
    const materialExpenses = expenses.filter((e) =>
      /^(Material|Waren|Rohstoffe?|Fremdleistung)/i.test(e.category || ''),
    )
    const personalExpenses = expenses.filter((e) =>
      /^(Personal|Lohn|Gehalt|SV)/i.test(e.category || ''),
    )
    const zinsExpenses = expenses.filter((e) =>
      /^(Schuldzins|Zins)/i.test(e.category || ''),
    )
    // Sonstige betriebliche Aufwendungen = all
    // expenses NOT in material / personal / zins
    // buckets. Tier 87: AfA is explicitly excluded
    // here too, in case any leftover AfA rows
    // slipped past the pull filter (defense in
    // depth — the filter is the primary guard).
    const sonstigeExpenses = expenses.filter(
      (e) =>
        !/^(Material|Waren|Rohstoffe?|Fremdleistung)/i.test(e.category || '') &&
        !/^(Personal|Lohn|Gehalt|SV)/i.test(e.category || '') &&
        !/^(Schuldzins|Zins)/i.test(e.category || '') &&
        !/^AfA/i.test(e.category || ''),
    )

    const materialaufwand = materialExpenses.reduce(
      (s, e) => s + Number(e.grossAmount),
      0,
    )
    const personalaufwand = personalExpenses.reduce(
      (s, e) => s + Number(e.grossAmount),
      0,
    )
    const sonstigeAufwendungen = sonstigeExpenses.reduce(
      (s, e) => s + Number(e.grossAmount),
      0,
    )
    const zinsaufwendungen = zinsExpenses.reduce(
      (s, e) => s + Number(e.grossAmount),
      0,
    )

    // ===== SONSTIGE BETRIEBLICHE ERTRÄGE =====
    // CustomerCreditTransaction with type
    // 'overpayment' or 'gutschrift' and amount
    // > 0 are positive credits the company
    // received but didn't apply to an invoice.
    // They're operational income (the company
    // got the money), so they belong here.
    //
    // Negative credits (payouts, applies) are
    // NOT income — they're the reverse.
    const credits = await this.prisma.customerCreditTransaction.findMany({
      where: {
        companyId,
        createdAt: { gte: yearStart, lte: yearEnd },
        type: { in: ['overpayment', 'gutschrift'] },
      },
      select: { amount: true },
    })
    const sonstigeErtrage = credits.reduce(
      (s, t) => s + (Number(t.amount) > 0 ? Number(t.amount) : 0),
      0,
    )

    // Tier 83: pull the Asset pool + compute
    // the annual AfA per asset. The 7a
    // Abschreibungen line gets real data for
    // companies that have registered Sachanlagen.
    // For companies without assets, 7a stays
    // "nicht ausgewiesen" (null).
    const yearAssets = await this.prisma.asset.findMany({
      where: { companyId },
    })
    const yearEndSnapshot = new Date(year, 11, 31, 23, 59, 59, 999)
    const annualAfA = yearAssets.reduce(
      (s, a) => s + this.assets.computeAfA(a, yearEndSnapshot).annualAfA,
      0,
    )
    const hasAssets = yearAssets.length > 0

    // ===== BUILD SECTIONS =====

    // Revenue (§ 275 HGB GKV positions 1-4)
    const revenue: GuVSection = {
      title: 'Erträge',
      lines: [
        {
          position: '1',
          label: 'Umsatzerlöse',
          amount: round2(umsatzerloese),
        },
        {
          position: '2',
          label: 'Bestandsveränderungen',
          amount: null,
          note: 'Vorratsbestand wird in de-invoice v1 nicht erfasst.',
        },
        {
          position: '3',
          label: 'Andere aktivierte Eigenleistungen',
          amount: null,
        },
        {
          position: '4',
          label: 'Sonstige betriebliche Erträge',
          amount: round2(sonstigeErtrage),
          note: 'Kundenguthaben-Überzahlungen + Gutschrift-Überhänge.',
        },
      ],
      subtotal: round2(umsatzerloese + sonstigeErtrage),
      nichtAusgewiesen: 2,
    }

    // Cost (§ 275 HGB GKV positions 5-8)
    // 7a Abschreibungen uses the BOOKED AfA sum
    // when the user has clicked "AfA buchen"
    // for this year (tier 87). Otherwise it
    // falls back to the computed annual AfA
    // from the Asset pool (tier 83). The
    // expense line is "nicht ausgewiesen" only
    // when the company has no assets AND no
    // booking — both can be true together for
    // a fresh company.
    const cost: GuVSection = {
      title: 'Aufwendungen',
      lines: [
        {
          position: '5a',
          label: 'Materialaufwand',
          amount: round2(materialaufwand),
        },
        {
          position: '6a',
          label: 'Personalaufwand',
          amount: round2(personalaufwand),
        },
        {
          position: '7a',
          label: 'Abschreibungen auf Sachanlagen',
          amount: useBookedAfA
            ? round2(bookedAfASum)
            : hasAssets
              ? round2(annualAfA)
              : null,
          note: useBookedAfA
            ? 'Gebucht aus Anlagenverzeichnis ("AfA buchen").'
            : hasAssets
              ? 'Berechnet aus dem Anlagenverzeichnis (lineare AfA).'
              : 'AfA wird berechnet, sobald Sachanlagen im Anlagenverzeichnis erfasst sind.',
        },
        {
          position: '8',
          label: 'Sonstige betriebliche Aufwendungen',
          amount: round2(sonstigeAufwendungen),
          note: 'Miete, Versicherung, Werbung, Telefon, Steuerberatung, Bürobedarf, etc.',
        },
      ],
      subtotal: round2(
        materialaufwand +
          personalaufwand +
          (useBookedAfA ? bookedAfASum : annualAfA) +
          sonstigeAufwendungen,
      ),
      // 7a is "nicht ausgewiesen" only when we
      // have neither a booking nor any assets.
      nichtAusgewiesen:
        useBookedAfA || hasAssets ? 0 : 1,
    }

    // Financial result (§ 275 HGB GKV positions 9-13)
    const financial: GuVSection = {
      title: 'Finanzergebnis',
      lines: [
        {
          position: '9',
          label: 'Erträge aus Beteiligungen',
          amount: null,
        },
        {
          position: '10',
          label: 'Erträge aus anderen Wertpapieren',
          amount: null,
        },
        {
          position: '11',
          label: 'Sonstige Zinsen und ähnliche Erträge',
          amount: null,
          note: 'Habenzinsen werden in de-invoice v1 nicht erfasst.',
        },
        {
          position: '12',
          label: 'Abschreibungen auf Finanzanlagen',
          amount: null,
        },
        {
          position: '13',
          label: 'Zinsen und ähnliche Aufwendungen',
          amount: round2(zinsaufwendungen),
        },
      ],
      subtotal: round2(-zinsaufwendungen), // financial income side is 0, so financial result = -(zinsaufwendungen)
      nichtAusgewiesen: 4,
    }

    // Tax (§ 275 HGB GKV positions 14, 16)
    const tax: GuVSection = {
      title: 'Steuern',
      lines: [
        {
          position: '14',
          label: 'Steuern vom Einkommen und Ertrag',
          amount: null,
          note: 'Ertragsteuern werden in de-invoice v1 nicht erfasst.',
        },
        {
          position: '16',
          label: 'Sonstige Steuern',
          amount: null,
        },
      ],
      subtotal: 0,
      nichtAusgewiesen: 2,
    }

    // Result (§ 275 HGB GKV position 17)
    // Betriebsergebnis = Erträge - Aufwendungen
    // Finanzergebnis = position 13 (with sign)
    // Ergeb. n. Steuern = Betriebsergebnis + Finanzergebnis (Steuern = 0 in v1)
    // Jahresüberschuss = Ergeb. n. Steuern - sonstige Steuern (0)
    const betriebsleistung = revenue.subtotal!
    const betriebsergebnis = betriebsleistung - cost.subtotal!
    const finanzergebnis = financial.subtotal!
    const ergebnisNachSteuern = betriebsergebnis + finanzergebnis - tax.subtotal!
    const jahresueberschuss = ergebnisNachSteuern // sonstige Steuern = 0 in v1

    const result: GuVSection = {
      title: 'Jahresergebnis',
      lines: [
        {
          position: '15',
          label: 'Ergebnis nach Steuern',
          amount: round2(ergebnisNachSteuern),
        },
        {
          position: '17',
          label:
            jahresueberschuss >= 0
              ? 'Jahresüberschuss'
              : 'Jahresfehlbetrag',
          amount: round2(jahresueberschuss),
        },
      ],
      subtotal: round2(jahresueberschuss),
      nichtAusgewiesen: 0,
    }

    return {
      year,
      companyId,
      revenue,
      cost,
      financial,
      tax,
      result,
      totals: {
        umsatzerloese: round2(umsatzerloese),
        betriebsleistung: round2(betriebsleistung),
        betriebsergebnis: round2(betriebsergebnis),
        finanzergebnis: round2(finanzergebnis),
        jahresueberschuss: round2(jahresueberschuss),
      },
      counts: {
        invoices: invoices.length,
        expenses: expenses.length,
        credits: credits.length,
        // Tier 87: how many AfA bookings exist
        // for this year. 0 = 7a line uses
        // the in-memory computed value; >0 =
        // 7a line uses real booked AfA Expense
        // rows.
        afaBookings: bookedAfa.length,
        assets: yearAssets.length,
      },
      // Tier 87: expose to the UI which mode
      // the 7a line is in.
      afaSource: useBookedAfA ? 'booked' : 'computed',
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese G+V ist eine VORSCHAU nach § 275 Abs. 2 HGB Gesamtkostenverfahren. ' +
        'de-invoice v1 erfasst nicht alle Positionen (AfA, Bestandsveränderungen, ' +
        'Beteiligungserträge, Zinserträge, Steuern vom Einkommen und Ertrag) — ' +
        'diese Positionen sind als "nicht ausgewiesen" markiert. Der Berater ' +
        'ergänzt die fehlenden Positionen aus dem Anlagenverzeichnis, den ' +
        'Steuerbescheiden und der BWA. Vor der Einreichung beim Finanzamt durch ' +
        'den Steuerberater prüfen lassen.',
    }
  }

  /**
   * Render the G+V as a GoBD-style A4 PDF. § 275
   * HGB GKV layout — sections in canonical order
   * (Revenue → Cost → Operating result → Financial
   * → Taxes → Result).
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
      `attachment; filename="GuV-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Gewinn- und Verlustrechnung ${year}`, { align: 'left' })
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(`(§ 275 Abs. 2 HGB — Gesamtkostenverfahren)`)
      .moveDown(0.2)
    doc.text(`${company?.name || companyId}`)
    doc.moveDown(1)

    // Sections in § 275 HGB order
    this.renderSection(doc, data.revenue)
    doc.moveDown(0.5)
    this.renderSection(doc, data.cost)
    doc.moveDown(0.5)
    this.renderSection(doc, data.financial)
    doc.moveDown(0.5)
    this.renderSection(doc, data.tax)
    doc.moveDown(0.5)
    this.renderSection(doc, data.result)

    // Summary strip
    doc.moveDown(1)
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
    doc.text('Zusammenfassung:')
    doc.moveDown(0.2)
    doc.fontSize(9).font('Helvetica')
    doc.text(`  Betriebsleistung:        ${this.fmtEur(data.totals.betriebsleistung)} €`)
    doc.text(`  Betriebsergebnis:        ${this.fmtEur(data.totals.betriebsergebnis)} €`)
    doc.text(`  Finanzergebnis:          ${this.fmtEur(data.totals.finanzergebnis)} €`)
    doc.text(`  Jahresüberschuss/-fehlbetrag: ${this.fmtEur(data.totals.jahresueberschuss)} €`)
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
          `Rechnungen: ${data.counts.invoices}  |  ` +
          `Ausgaben: ${data.counts.expenses}  |  ` +
          `de-invoice · G+V Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderSection(doc: PDFKit.PDFDocument, section: GuVSection): void {
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#000')
    doc.text(section.title)
    doc.moveDown(0.2)
    const colPos = 50
    const colLabel = 90
    const colAmount = 380
    doc.fontSize(9).font('Helvetica-Bold')
    const tableTop = doc.y
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
        doc
          .fillColor('#999')
          .text('— nicht ausgewiesen —', colAmount, y, { width: 115, align: 'right' })
          .fillColor('#000')
      } else {
        doc.text(this.fmtEur(l.amount), colAmount, y, { width: 115, align: 'right' })
      }
      doc.moveDown(0.15)
      if (l.note) {
        doc
          .fontSize(7)
          .fillColor('#666')
          .text(`↳ ${l.note}`, colLabel, doc.y, { width: 380 })
          .fillColor('#000')
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
