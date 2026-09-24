import { resolveRechtsform, isKapitalgesellschaft as isKapitalgesellschaftFn } from '../company/rechtsform'
import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { GuVService } from './guv.service'
import { BilanzService } from './bilanz.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 102: KSt 1 (Körperschaftsteuererklärung).
 *
 * The annual corporate tax return for
 * Kapitalgesellschaften (GmbH, AG, KGaA, etc.)
 * and other KSt-pflichtige entities per § 1
 * Abs. 1 KStG. Pairs with the E-Bilanz (tier
 * 88/97) for the Jahresabschluss-based filing.
 *
 * KSt 1 is the **primary** tax form for any
 * GmbH. Anlage G is NOT applicable (the § 15
 * EStG Einkünfte aus Gewerbebetrieb category
 * is for Einkommensteuer-pflichtige natürliche
 * Personen, not Kapitalgesellschaften).
 *
 * Three components (all on the bottom line):
 *   1. **Körperschaftsteuer (KSt)** — 15% flat
 *      on the Zu versteuerndes Einkommen (ZvE).
 *      NO Freibetrag (unlike Einkommensteuer
 *      with the 1.000 EUR / 24.500 EUR
 *      Freibetrag in § 24 KStG applies only to
 *      certain Vereine / Genossenschaften).
 *      GmbH + AG = full 15% on every EUR.
 *   2. **Solidaritätszuschlag (Soli)** — 5.5%
 *      on the KSt (not on the ZvE directly).
 *   3. **Gewerbesteuer (GewSt)** — for GmbH
 *      with NO 24 500 € Freibetrag (Freibetrag
 *      gilt nur für Einzelunternehmen +
 *      Personengesellschaften). Formula:
 *        Steuermessbetrag = ZvE, rounded down to
 *          full 100 € (§ 11 Abs. 1 GewStG), × 3.5 %
 *        GewSt = Messbetrag × Hebesatz / 100
 *
 * Tier 439: there is no credit of the GewSt against
 * the KSt. This report subtracted min(KSt, 3.8 ×
 * Messbetrag) — the Steuerermäßigung of § 35 EStG,
 * which reduces the INCOME tax of natural persons
 * with Gewerbe income (Einzelunternehmer,
 * Mitunternehmer) and does not apply to a
 * Kapitalgesellschaft (§ 26 KStG is the credit for
 * foreign taxes). Measured at 100 050 € profit and
 * Hebesatz 400: KSt 15 007,50 € reduced to 1 700,85 €,
 * "zu zahlen" 16 533,26 € instead of 29 832,91 €.
 *
 * v1 heuristic: read the G+V Jahresüberschuss
 * (= Zu versteuerndes Einkommen pre-Korrekturen)
 * from the existing GuVService. The
 * Berater adjusts:
 *   - Hebesatz der Gemeinde (Company.settings.hebesatz, default 400)
 *   - Verdeckte Gewinnausschüttungen (§ 8 Abs. 3 KStG) — placeholder
 *   - Spendenabzug (§ 9 Abs. 1 Nr. 2 KStG) — placeholder
 *   - Verlustabzug (§ 8 Abs. 1 KStG) — placeholder
 *   - KSt-Vorauszahlungen / GewSt-Vorauszahlungen — placeholder
 *
 * v2 work: separate KSt + GewSt Korrekturen
 * data model on Company.settings.kst1Korrekturen[year].
 *
 * Filing order: KSt 1 is filed AFTER the
 * Jahresabschluss (Bilanz + G+V + Anhang) is
 * finalized. The Berater packager includes
 * KSt 1 at slot 05 (after G, before N — KSt
 * is company-level, N is personal income).
 */
export interface KSt1Line {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

export interface KSt1Result {
  year: number
  companyId: string
  isKapitalgesellschaft: boolean
  rechtsform: string
  // Bilanz / G+V-derived
  jahresueberschuss: number
  // KSt-relevant corrections
  corrections: KSt1Line[]
  // Bottom-line
  totals: {
    jahresueberschuss: number
    zve: number // Zu versteuerndes Einkommen
    kst: number // 15% × ZvE
    soli: number // 5.5% × KSt
    gewstMessbetrag: number // 3.5% × ZvE
    hebesatz: number // default 400
    gewst: number // Messbetrag × Hebesatz / 100
    zuZahlen: number // KSt + Soli + GewSt (Tier 439: no § 35 EStG credit)
  }
  counts: {
    invoices: number
    expenses: number
    jahresueberschussSource: 'computed' | 'nicht_ausgewiesen'
  }
  generatedAt: string
  disclaimer: string
}

// Tier 102: KSt 1 Korrekturen Kz 30-90 (internal namespace).
// Most are placeholder for the Berater — v1
// only auto-applies the standard KSt + GewSt.
// The Berater adds the company-
// specific adjustments.
const KORREKTUREN_LINES: Array<{
  kz: string
  label: string
  note: string
}> = [
  {
    kz: '30',
    label: 'Verdeckte Gewinnausschüttungen (§ 8 Abs. 3 KStG) — Hinzurechnung',
    note: 'vGAs sind nicht-bilanzielle Korrekturen — z.B. Geschäftsführer-Vergütung über dem Fremdvergleich, Mieten an Gesellschafter zu niedrig, etc. Vom Berater aus dem Anlagenverzeichnis + den Verträgen zu ergänzen.',
  },
  {
    kz: '31',
    label: 'Verdeckte Einlagen (§ 8 Abs. 3 KStG) — Kürzung',
    note: 'vEs sind nicht-bilanzielle Korrekturen — z.B. Gesellschafter verzichten auf Mieten, etc. Vom Berater zu ergänzen.',
  },
  {
    kz: '40',
    label: 'Spendenabzug (§ 9 Abs. 1 Nr. 2 KStG) — Kürzung',
    note: 'Steuerbegünstigte Spenden (Gemeinnützigkeit) sind bis 20% des Einkommens abzugsfähig. Vom Berater aus den Spendenbescheinigungen zu ergänzen.',
  },
  {
    kz: '50',
    label: 'Verlustabzug (§ 8 Abs. 1 KStG) — Kürzung',
    note: 'Nicht ausgeglichene Verluste (Vj. + Vor-Vj.) sind bis 1.000.000 EUR + 60% des übersteigenden ZvE abzugsfähig (Mindestbesteuerung). Vom Berater aus dem Verlustvortragsbescheid zu ergänzen.',
  },
  {
    kz: '60',
    label: 'KSt-Vorauszahlungen / GewSt-Vorauszahlungen — bereits gezahlt (zur Information)',
    note: 'Vom Berater aus den Steuerbescheiden (Vorauszahlungsbescheide) zu ergänzen. Diese Beträge werden in der Festsetzung mit der Steuerschuld verrechnet.',
  },
  {
    kz: '70',
    label: 'Anrechenbare ausländische Steuern (§ 26 KStG i.V.m. § 34c EStG) — Kürzung',
    note: 'Im Ausland gezahlte Ertragsteuern auf ausländische Betriebsstätten-Ergebnisse. Vom Berater zu ergänzen.',
  },
  {
    kz: '80',
    label: 'Nicht abzugsfähige Aufwendungen (§ 8b KStG) — Hinzurechnung',
    note: 'z.B. 5% des Kfz-Sachbezugs (Gesellschafter-Geschäftsführer), 30% der Aufsichtsrats-Vergütungen. Vom Berater zu ergänzen.',
  },
  {
    kz: '90',
    label: 'Sonstige Hinzurechnungen / Kürzungen (§ 8 KStG Rest)',
    note: 'Vom Berater zu ergänzen.',
  },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class KSt1Service {
  constructor(
    private prisma: PrismaService,
    private guv: GuVService,
    private bilanz: BilanzService,
  ) {}

  /**
   * Compute the KSt 1 for the year. Returns
   * the report JSON. The controller wraps this
   * in the year-defaults + auth handling.
   *
   * v1: read the GuV Jahresüberschuss + apply
   * the standard KSt + GewSt formulas. Most Korrekturen (vGA, Spenden,
   * Verlustabzug) are placeholder for the
   * Berater.
   */
  async compute(companyId: string, year: number): Promise<KSt1Result> {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) {
      throw new BadRequestException('Firma nicht gefunden')
    }
    // Tier 441: the company's legal form (was a column that did not exist,
    // defaulting to GmbH; and a GmbH & Co. KG — a partnership — counted as a
    // corporation).
    const resolved = resolveRechtsform(company)
    const rechtsform = resolved.rechtsform ?? 'nicht angegeben'
    const isKapitalgesellschaft = isKapitalgesellschaftFn(resolved.rechtsform)

    // Pull the G+V Jahresüberschuss (the
    // accounting profit, pre-KSt-corrections).
    // This is the starting point for the ZvE.
    // Note: the G+V is in HGB format — for
    // KSt-relevant corrections (vGAs, Spenden,
    // etc.) we apply them in the corrections
    // block below.
    const guvData = await this.guv.compute(companyId, year)
    const jahresueberschuss = guvData.totals.jahresueberschuss
    const jahresueberschussSource = jahresueberschuss > 0 || jahresueberschuss < 0
      ? 'computed'
      : 'nicht_ausgewiesen'

    // Hebesatz der Gemeinde (default 400 = Münster).
    // User adjusts via Company.settings.hebesatz
    // — Köln 470, München 490, etc.
    const settings = (company.settings as any) || {}
    const hebesatz =
      typeof settings.hebesatz === 'number' && settings.hebesatz > 0
        ? settings.hebesatz
        : 400

    // KSt-Korrekturen: v1 all placeholder (Berater
    // ergänzt aus den Verträgen / Verlustvorträgen
    // / Spendenbescheinigungen). v2: read from
    // Company.settings.kst1Korrekturen[year].
    const corrections: KSt1Line[] = KORREKTUREN_LINES.map((d) => ({
      kennziffer: d.kz,
      label: d.label,
      amount: 0,
      source: 'placeholder',
      note: d.note,
    }))

    // Compute ZvE: For v1, ZvE = Jahresüberschuss.
    // The Korrekturen are all 0 in v1 (placeholder).
    // v2: ZvE = Jahresüberschuss + Σ Korrekturen.
    const korrekturenTotal = corrections.reduce((s, l) => s + l.amount, 0)
    const zve = round2(jahresueberschuss + korrekturenTotal)

    // KSt: 15% × max(0, ZvE). For ZvE <= 0 (loss),
    // KSt is 0 and the Verlustvortrag (Kz 50) carries
    // forward.
    const kst = round2(Math.max(0, zve) * 0.15)
    // Soli: 5.5% × KSt. Note: Soli is on the KSt
    // (not the ZvE directly), per § 3 SolzG.
    const soli = round2(kst * 0.055)

    // Gewerbesteuer:
    //   Steuermessbetrag = max(0, ZvE) rounded down to 100 € × 3.5%
    //   GewSt = Messbetrag × Hebesatz / 100
    // For GmbH: NO 24 500 € Freibetrag (Freibetrag gilt
    // nur für Einzelunternehmen / Personengesell-
    // schaften per § 11 Abs. 1 GewStG).
    const gewstMessbetrag = round2(Math.max(0, Math.floor(zve / 100) * 100) * 0.035)
    const gewst = round2(gewstMessbetrag * hebesatz / 100)

    // Zu zahlen = KSt + Soli + GewSt. Tier 439: no credit of the GewSt
    // against the KSt — § 35 EStG is for natural persons (see the header).
    const zuZahlen = round2(kst + soli + gewst)

    return {
      year,
      companyId,
      isKapitalgesellschaft,
      rechtsform,
      jahresueberschuss: round2(jahresueberschuss),
      corrections,
      totals: {
        jahresueberschuss: round2(jahresueberschuss),
        zve,
        kst,
        soli,
        gewstMessbetrag,
        hebesatz,
        gewst,
        zuZahlen,
      },
      counts: {
        invoices: guvData.counts.invoices,
        expenses: guvData.counts.expenses,
        jahresueberschussSource,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus dem G+V Jahresüberschuss + den KSt-/GewSt-' +
        'Standardformeln generiert. KSt 1 ist für Körperschaften (GmbH, AG, KGaA, etc.) per ' +
        '§ 1 Abs. 1 KStG. KSt 15% + Soli 5.5% (auf KSt) + GewSt (default Hebesatz 400 % — bitte ' +
        'an die Gemeinde anpassen). Die Gewerbesteuer wird NICHT auf die KSt angerechnet (die ' +
        'Steuerermäßigung des § 35 EStG gilt nur für natürliche Personen). Im Gegensatz zur Einkommensteuer KEIN Freibetrag für GmbH/AG. Die KSt-Korrekturen ' +
        '(vGAs, Spendenabzug, Verlustabzug, ausländische Steuern, § 8b KStG) sind als Platzhalter ' +
        'markiert — der Steuerberater ergänzt sie aus dem Anlagenverzeichnis, den Verträgen und ' +
        'den Steuerbescheiden. v2: Korrekturen werden aus Company.settings.kst1Korrekturen[year] gelesen.',
    }
  }

  /**
   * Render the KSt 1 as a GoBD-style A4 PDF.
   * Layout: header + Jahresüberschuss summary
   * + Korrekturen table + ZvE + KSt + Soli +
   * GewSt breakdown + Zu zahlen
   * + disclaimer + footer.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="KSt1-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`KSt 1 ${year} — VORSCHAU`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Körperschaftsteuererklärung (§ 1 Abs. 1 KStG) — ${company?.legalName || company?.name || companyId} (${data.rechtsform})`,
      )
      .moveDown(0.5)
    doc
      .fontSize(9)
      .fillColor(data.isKapitalgesellschaft ? '#047857' : '#b45309')
      .text(
        data.isKapitalgesellschaft
          ? `✓ Körperschaft (${data.rechtsform}) — KSt 1 ist die zutreffende Erklärung.`
          : `⚠ Rechtsform ${data.rechtsform} ist KEINE Kapitalgesellschaft. KSt 1 gilt nur für Körperschaften. Für Einkünfte aus Gewerbebetrieb Einzelunternehmen / Personengesellschaften: Anlage G + Einkommensteuererklärung.`,
      )
      .fillColor('#000')
    doc.moveDown(1)

    // Jahresüberschuss block
    doc.fontSize(12).font('Helvetica-Bold').text('Jahresüberschuss / -fehlbetrag (aus G+V § 275 HGB)')
    doc.moveDown(0.3)
    doc.fontSize(10).font('Helvetica')
    doc.text(
      `Jahresüberschuss: ${this.fmtEur(data.totals.jahresueberschuss)} € ` +
        `(${data.counts.jahresueberschussSource === 'computed' ? 'aus G+V Vorschau' : 'nicht ausgewiesen'})`,
    )
    doc.moveDown(0.8)

    // Korrekturen
    doc.fontSize(12).font('Helvetica-Bold').text('KSt-Korrekturen (§ 8 KStG)')
    doc.moveDown(0.3)
    this.renderTable(
      doc,
      data.corrections,
      data.corrections.reduce((s, l) => s + l.amount, 0),
      'Korrekturen',
    )
    doc.moveDown(0.8)

    // ZvE
    doc.fontSize(13).font('Helvetica-Bold')
    doc.text(
      `Zu versteuerndes Einkommen (ZvE): ${this.fmtEur(data.totals.zve)} €`,
    )
    doc.moveDown(1)

    // KSt
    doc.fontSize(12).font('Helvetica-Bold').text('Körperschaftsteuer (KSt)')
    doc.moveDown(0.3)
    doc.fontSize(10).font('Helvetica')
    doc.text(`Steuersatz: 15 % (§ 23 Abs. 1 KStG)`)
    doc.text(`KSt: ${this.fmtEur(data.totals.kst)} €`)
    doc.moveDown(0.8)

    // Soli
    doc.fontSize(12).font('Helvetica-Bold').text('Solidaritätszuschlag (Soli)')
    doc.moveDown(0.3)
    doc.fontSize(10).font('Helvetica')
    doc.text(`Satz: 5,5 % auf die KSt (§ 3 SolzG)`)
    doc.text(`Soli: ${this.fmtEur(data.totals.soli)} €`)
    doc.moveDown(0.8)

    // GewSt
    doc.fontSize(12).font('Helvetica-Bold').text('Gewerbesteuer (GewSt)')
    doc.moveDown(0.3)
    doc.fontSize(10).font('Helvetica')
    doc.text(`Steuermesszahl: 3,5 % (§ 11 Abs. 2 GewStG)`)
    doc.text(`Steuermessbetrag: ${this.fmtEur(data.totals.gewstMessbetrag)} €`)
    doc.text(`Hebesatz: ${data.totals.hebesatz} % (default 400 % — bitte prüfen)`)
    doc.text(
      `GewSt: ${this.fmtEur(data.totals.gewst)} € ` +
        `(= Messbetrag × Hebesatz / 100)`,
    )
    doc.moveDown(0.8)


    // Zu zahlen
    doc.fontSize(14).font('Helvetica-Bold')
    doc
      .fillColor('#b91c1c')
      .text(
        `Zu zahlen: ${this.fmtEur(data.totals.zuZahlen)} €`,
      )
      .fillColor('#000')
    doc.moveDown(0.3)
    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .fillColor('#666')
      .text(
        '= KSt + Soli + GewSt (keine Anrechnung der GewSt auf die KSt — § 35 EStG gilt nur für natürliche Personen). KSt-Vorauszahlungen / GewSt-Vorauszahlungen (Kz 60) sind hier NICHT berücksichtigt — der Berater subtrahiert die bereits gezahlten Vorauszahlungen in der Festsetzung.',
        { width: 515 },
      )
      .fillColor('#000')
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
          `Rechnungen: ${data.counts.invoices}  |  Ausgaben: ${data.counts.expenses}  |  ` +
          `de-invoice · KSt 1 Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: KSt1Line[],
    total: number,
    blockLabel: string,
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
    doc.text(`Summe ${blockLabel}`, colKz + 35, doc.y, { width: 320 })
    doc.text(this.fmtEur(total), colAmount, doc.y, {
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
