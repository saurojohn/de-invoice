import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 101: Anlage N — Einkünfte aus
 * nichtselbständiger Arbeit (§ 3 EStG).
 *
 * The German tax filing for employees
 * (Arbeitnehmer) — the year-end attachment to
 * the Einkommensteuererklärung. Covers
 * Bruttoarbeitslohn + Lohnsteuer + Soli +
 * Kirchensteuer + Sozialversicherungs-
 * beiträge + Werbungskosten.
 *
 * Data source: the Lohnsteuerbescheinigung
 * (annual wage tax certificate) issued by
 * the employer. Each Lohnsteuerbescheinigung
 * is keyed by year and stored on
 * Company.settings.lohnsteuerbescheinigungen
 * (JSONB). The user enters it once per year
 * (the Berater's Lohnsteuerbescheinigung is
 * a single A4 page, easy to transcribe).
 *
 * v1 heuristic: Brutto + Lohnsteuer + Soli +
 * KiSt + SV come from the Lohnsteuerbescheinigung.
 * Werbungskosten use the Arbeitnehmer-
 * Pauschbetrag (1.230 EUR) by default; the
 * user adds Entfernungspauschale, Fortbildung,
 * etc. via the section's manual inputs. v2
 * could compute Entfernungspauschale from
 * home address + work address (geocoding).
 *
 * v1 also includes Sonderausgaben
 * (Vorsorgeaufwand — the user-entered
 * KV/PV-Beiträge above the Grundhöchstbetrag)
 * and Außergewöhnliche Belastungen
 * (Placeholder for Berater — Krankheitskosten,
 * Behinderung, etc.).
 *
 * The bottom line is the Anlage-N-Einkünfte
 * (= Brutto − Werbungskosten − Sonderausgaben
 * − Außergewöhnliche Belastungen − Altersent-
 * lastungsbetrag). The user adds this to their
 * total Einkünfte in the Hauptvordruck.
 *
 * For self-employed (Anlage S / G) and
 * capital income (Anlage KAP), Anlage N is
 * optional (you'd skip it if you have no
 * employer income). The opt-in flag
 * `Company.settings.anlageN === true` gates
 * whether the report is generated. v1 also
 * auto-detects Lohnsteuerbescheinigungen
 * in the year (any value > 0 for brutto).
 *
 * The Kennziffern 100-200 are an internal
 * namespace (not BMF's actual Zeile numbers
 * in the printable Anlage N form). The Berater
 * maps them to the BMF Zeile positions when
 * transcribing the VORSCHAU into the actual
 * ElsterForm / PDF form.
 */
export interface AnlageNLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

export interface AnlageNResult {
  year: number
  companyId: string
  lohnsteuerbescheinigung: {
    bruttoArbeitslohn: number
    lohnsteuer: number
    soli: number
    kirchensteuer: number
    rentenversicherung: number
    arbeitslosenversicherung: number
    krankenversicherung: number
    pflegeversicherung: number
  }
  einnahmen: AnlageNLine[]
  werbungskosten: AnlageNLine[]
  sonderausgaben: AnlageNLine[]
  aussergewoehnlicheBelastungen: AnlageNLine[]
  totals: {
    bruttoArbeitslohn: number
    lohnsteuerTotal: number // Lohnsteuer + Soli + KiSt
    werbungskostenTotal: number
    sonderausgabenTotal: number
    aussergewoehnlicheBelastungenTotal: number
    altersentlastungsbetrag: number // Kz 41-44 (§ 24a EStG)
    einkuenfte: number // Brutto - WK - SA - aB - Altersentlastung
  }
  counts: {
    hasLohnsteuerbescheinigung: boolean
  }
  generatedAt: string
  disclaimer: string
}

// Tier 101: Lohnsteuerbescheinigung Kennziffern 100-160.
// These are the values from the BMF
// Lohnsteuerbescheinigung 2026 (the form the
// employer issues to the employee each year).
// The user enters these once per year in
// Company.settings.
const LOHNSTEUERBESCHEINIGUNG_KEYS: Array<{
  key: keyof AnlageNResult['lohnsteuerbescheinigung']
  label: string
  min: number
}> = [
  { key: 'bruttoArbeitslohn', label: 'Bruttoarbeitslohn (Kz 3)', min: 0 },
  { key: 'lohnsteuer', label: 'Lohnsteuer (Kz 4)', min: 0 },
  { key: 'soli', label: 'Solidaritätszuschlag (Kz 5)', min: 0 },
  { key: 'kirchensteuer', label: 'Kirchensteuer (Kz 6)', min: 0 },
  { key: 'rentenversicherung', label: 'Rentenversicherung Arbeitnehmer-Anteil (Kz 7)', min: 0 },
  { key: 'arbeitslosenversicherung', label: 'Arbeitslosenversicherung Arbeitnehmer-Anteil (Kz 8)', min: 0 },
  { key: 'krankenversicherung', label: 'Krankenversicherung Arbeitnehmer-Anteil (Kz 9)', min: 0 },
  { key: 'pflegeversicherung', label: 'Pflegeversicherung Arbeitnehmer-Anteil (Kz 10)', min: 0 },
]

// Tier 101: Werbungskosten Kennziffern 130-180.
// Arbeitnehmer-Pauschbetrag (130) defaults to
// 1.230 EUR — the user opts out by adding
// real Werbungskosten (Entfernungspauschale,
// Fortbildung, Arbeitsmittel, etc.).
// v1: the user enters these via the section's
// manual input. v2: compute Entfernungspauschale
// from home address + work address.
const WERBUNGSKOSTEN_LINES: Array<{ kz: string; label: string; amount: number | 'auto'; note?: string }> = [
  {
    kz: '130',
    label: 'Arbeitnehmer-Pauschbetrag (§ 9a EStG, automatisch 1.230 EUR)',
    amount: 1230,
  },
  {
    kz: '140',
    label: 'Entfernungspauschale (0,30 EUR je km einfache Strecke, ab 21. km 0,38 EUR)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen — Anzahl der Arbeitstage × Kilometer × 0,30 EUR.',
  },
  {
    kz: '150',
    label: 'Beiträge zu Berufsverbänden (Gewerkschaft, Kammer, etc.)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen.',
  },
  {
    kz: '160',
    label: 'Arbeitsmittel (Fachliteratur, Werkzeug, Bürobedarf)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen.',
  },
  {
    kz: '170',
    label: 'Fortbildungskosten (Kurse, Seminare, Studiengebühren)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen.',
  },
  {
    kz: '180',
    label: 'Doppelte Haushaltsführung (Miete Zweitwohnung, Familienheimfahrten)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen.',
  },
  {
    kz: '190',
    label: 'Sonstige Werbungskosten (Bewerbungskosten, Kontoführungsgebühren, etc.)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen.',
  },
]

// Tier 101: Sonderausgaben Kennziffern 200-220.
// Vorsorgeaufwand (KV/PV/RV/AV) above the
// Grundhöchstbetrag. The Lohnsteuerbescheinigung
// already deducts KV/PV-Anteile from the
// Brutto, so the user-entered Sonderausgaben
// here are typically the rest of the
// Vorsorgeaufwand (Basis-Rente, Riester).
const SONDERAUSGABEN_LINES: Array<{ kz: string; label: string; amount: number | 'auto'; note?: string }> = [
  {
    kz: '200',
    label: 'Vorsorgeaufwand — Basis-Rente / Rürup (Altersvorsorge, nicht Riester)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen — bis 27.566 EUR / 55.132 EUR Zusammenveranlagung abzugsfähig (2026).',
  },
  {
    kz: '210',
    label: 'Riester-Rente (staatlich geförderte Altersvorsorge)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen — Zulage + Sonderausgabenabzug.',
  },
  {
    kz: '220',
    label: 'Sonstige Vorsorgeaufwendungen (Unfallversicherung, Haftpflicht, etc.)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen.',
  },
]

// Tier 101: Außergewöhnliche Belastungen Kennziffern 230-260.
// Krankheitskosten, Behinderung, Bestattungskosten, etc.
// Most are only relevant if the user actually has these
// costs in the year — placeholder for the user.
const AUSSERGEWOEHNLICHE_BELASTUNGEN_LINES: Array<{
  kz: string
  label: string
  amount: number | 'auto'
  note?: string
}> = [
  {
    kz: '230',
    label: 'Krankheitskosten (Selbstbehalt, Brille, Zahnarzt, etc.)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen — abzugsfähig ab 1% des Brutto (zumutbare Belastung).',
  },
  {
    kz: '240',
    label: 'Behinderung (Behinderten-Pauschbetrag nach Grad der Behinderung)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen — Pauschbetrag je nach GdB.',
  },
  {
    kz: '250',
    label: 'Bestattungskosten (über Nachlass / Sozialhilfe hinaus)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen — abzugsfähig nur soweit nicht aus Nachlass gedeckt.',
  },
  {
    kz: '260',
    label: 'Sonstige außergewöhnliche Belastungen (Pflege, Scheidung, etc.)',
    amount: 0,
    note: 'Vom Arbeitnehmer manuell einzutragen.',
  },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class AnlageNService {
  constructor(private prisma: PrismaService) {}

  /**
   * Compute the Anlage N for the year. Returns
   * the report JSON. The controller wraps this
   * in the year-defaults + auth handling.
   *
   * v1: read the Lohnsteuerbescheinigung from
   * Company.settings.lohnsteuerbescheinigungen
   * (a map of year → values). The Werbungs-
   * kosten use the standard Pauschbetrag +
   * user-entered values from settings.
   * Sonderausgaben + aB are user-entered.
   */
  async compute(companyId: string, year: number): Promise<AnlageNResult> {
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

    // Lohnsteuerbescheinigung: per-year map
    // inside Company.settings.lohnsteuerbescheinigungen
    // (BMF: Lohnsteuerbescheinigung 2026 issued by
    // the employer in January 2027). The user enters
    // the values once per year via the section's
    // manual input. v1: no validation of cross-year
    // consistency — the Berater catches duplicates.
    const lsbAll = (settings.lohnsteuerbescheinigungen as any) || {}
    const lsb = lsbAll[year] || {}
    const lsbValues: AnlageNResult['lohnsteuerbescheinigung'] = {
      bruttoArbeitslohn: 0,
      lohnsteuer: 0,
      soli: 0,
      kirchensteuer: 0,
      rentenversicherung: 0,
      arbeitslosenversicherung: 0,
      krankenversicherung: 0,
      pflegeversicherung: 0,
    }
    for (const k of LOHNSTEUERBESCHEINIGUNG_KEYS) {
      const v = Number(lsb[k.key])
      lsbValues[k.key] = Number.isFinite(v) && v >= k.min ? v : 0
    }
    const hasLohnsteuerbescheinigung =
      lsbValues.bruttoArbeitslohn > 0 ||
      lsbValues.lohnsteuer > 0 ||
      lsbValues.soli > 0 ||
      lsbValues.kirchensteuer > 0

    // Einnahmen: the Bruttoarbeitslohn as
    // the single line. The Lohnsteuer/Soli/
    // KiSt are negative (already paid).
    const einnahmen: AnlageNLine[] = [
      {
        kennziffer: '100',
        label: 'Bruttoarbeitslohn (Lohnsteuerbescheinigung Kz 3)',
        amount: round2(lsbValues.bruttoArbeitslohn),
        source: 'computed',
      },
    ]

    // Werbungskosten: 130 (Pauschbetrag) auto
    // at 1.230 EUR, the rest from settings.werbungs-
    // kosten[year][kz] (user-entered).
    const wkUser = ((settings.werbungskosten || {})[year] || {}) as Record<string, number>
    const werbungskosten: AnlageNLine[] = WERBUNGSKOSTEN_LINES.map((d) => {
      const amount =
        d.amount === 'auto'
          ? 1230
          : Number.isFinite(Number(wkUser[d.kz]))
            ? Number(wkUser[d.kz])
            : d.amount
      return {
        kennziffer: d.kz,
        label: d.label,
        amount: round2(amount),
        source: d.amount === 'auto' ? 'computed' : 'placeholder',
        note: d.note,
      }
    })
    const werbungskostenTotal = werbungskosten.reduce((s, l) => s + l.amount, 0)

    // Sonderausgaben
    const saUser = ((settings.sonderausgaben || {})[year] || {}) as Record<string, number>
    const sonderausgaben: AnlageNLine[] = SONDERAUSGABEN_LINES.map((d) => {
      const amount =
        d.amount === 'auto'
          ? 0
          : Number.isFinite(Number(saUser[d.kz]))
            ? Number(saUser[d.kz])
            : d.amount
      return {
        kennziffer: d.kz,
        label: d.label,
        amount: round2(amount),
        source: 'placeholder',
        note: d.note,
      }
    })
    const sonderausgabenTotal = sonderausgaben.reduce((s, l) => s + l.amount, 0)

    // Außergewöhnliche Belastungen
    const abUser = ((settings.aussergewoehnlicheBelastungen || {})[year] || {}) as Record<string, number>
    const aussergewoehnlicheBelastungen: AnlageNLine[] = AUSSERGEWOEHNLICHE_BELASTUNGEN_LINES.map((d) => {
      const amount =
        d.amount === 'auto'
          ? 0
          : Number.isFinite(Number(abUser[d.kz]))
            ? Number(abUser[d.kz])
            : d.amount
      return {
        kennziffer: d.kz,
        label: d.label,
        amount: round2(amount),
        source: 'placeholder',
        note: d.note,
      }
    })
    const aussergewoehnlicheBelastungenTotal = aussergewoehnlicheBelastungen.reduce(
      (s, l) => s + l.amount,
      0,
    )

    // Altersentlastungsbetrag (§ 24a EStG): only
    // for employees born before 1940. v1: assume
    // none (default 0). The user adjusts if
    // applicable.
    const altersentlastungsbetrag = 0

    const einkuenfte = round2(
      lsbValues.bruttoArbeitslohn -
        werbungskostenTotal -
        sonderausgabenTotal -
        aussergewoehnlicheBelastungenTotal -
        altersentlastungsbetrag,
    )

    // Lohnsteuer total (Lohnsteuer + Soli + KiSt)
    // is informational only — the user reports
    // the gross + the already-paid tax on the
    // Anlage N; the Finanzamt offsets the
    // Lohnsteuer against the calculated
    // Einkommensteuer in the Festsetzung.
    const lohnsteuerTotal = round2(
      lsbValues.lohnsteuer + lsbValues.soli + lsbValues.kirchensteuer,
    )

    return {
      year,
      companyId,
      lohnsteuerbescheinigung: {
        bruttoArbeitslohn: round2(lsbValues.bruttoArbeitslohn),
        lohnsteuer: round2(lsbValues.lohnsteuer),
        soli: round2(lsbValues.soli),
        kirchensteuer: round2(lsbValues.kirchensteuer),
        rentenversicherung: round2(lsbValues.rentenversicherung),
        arbeitslosenversicherung: round2(lsbValues.arbeitslosenversicherung),
        krankenversicherung: round2(lsbValues.krankenversicherung),
        pflegeversicherung: round2(lsbValues.pflegeversicherung),
      },
      einnahmen,
      werbungskosten,
      sonderausgaben,
      aussergewoehnlicheBelastungen,
      totals: {
        bruttoArbeitslohn: round2(lsbValues.bruttoArbeitslohn),
        lohnsteuerTotal,
        werbungskostenTotal: round2(werbungskostenTotal),
        sonderausgabenTotal: round2(sonderausgabenTotal),
        aussergewoehnlicheBelastungenTotal: round2(aussergewoehnlicheBelastungenTotal),
        altersentlastungsbetrag: round2(altersentlastungsbetrag),
        einkuenfte,
      },
      counts: {
        hasLohnsteuerbescheinigung,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihren Lohnsteuerbescheinigungs-Daten ' +
        '(Company.settings) + den manuell eingetragenen Werbungskosten / Sonderausgaben / ' +
        'Außergewöhnlichen Belastungen generiert. Anlage N ist für Einkünfte aus ' +
        'nichtselbständiger Arbeit (§ 3 EStG) — Arbeitnehmer, Beamte, Gesellschafter-' +
        'Geschäftsführer mit Anstellung, Teilzeit-Beschäftigte. Der Berater ergänzt ' +
        'die fehlenden Werte aus der Lohnsteuerbescheinigung des Arbeitgebers und ' +
        'prüft die Werbungskosten-Höchstbeträge. Bei mehreren Arbeitgebern: Lohnsteuer' +
        'bescheinigungen aller Arbeitgeber zusammenführen.',
    }
  }

  /**
   * Render the Anlage N as a GoBD-style A4 PDF.
   * Same layout family as the other Anlagen:
   * header + 4 tables (Einnahmen + Werbungs-
   * kosten + Sonderausgaben + Außergewöhnliche
   * Belastungen) + Einkünfte pill + Lohnsteuer
   * info box + disclaimer + footer.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-N-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage N ${year} — VORSCHAU`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Einkünfte aus nichtselbständiger Arbeit (§ 3 EStG) — ${company?.name || companyId}`,
      )
      .moveDown(1)

    // Lohnsteuerbescheinigung summary box
    if (data.counts.hasLohnsteuerbescheinigung) {
      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('Lohnsteuerbescheinigung')
      doc.moveDown(0.3)
      doc.fontSize(9).font('Helvetica')
      const lsb = data.lohnsteuerbescheinigung
      doc.text(`Bruttoarbeitslohn: ${this.fmtEur(lsb.bruttoArbeitslohn)} €`)
      doc.text(`Lohnsteuer: ${this.fmtEur(lsb.lohnsteuer)} €`)
      doc.text(`Solidaritätszuschlag: ${this.fmtEur(lsb.soli)} €`)
      doc.text(`Kirchensteuer: ${this.fmtEur(lsb.kirchensteuer)} €`)
      doc.text(`SV-Anteile (RV ${this.fmtEur(lsb.rentenversicherung)} + AV ${this.fmtEur(lsb.arbeitslosenversicherung)} + KV ${this.fmtEur(lsb.krankenversicherung)} + PV ${this.fmtEur(lsb.pflegeversicherung)})`)
      doc.moveDown(1)
    } else {
      doc
        .fontSize(10)
        .font('Helvetica-Oblique')
        .fillColor('#b45309')
        .text(
          '⚠ Keine Lohnsteuerbescheinigung für dieses Jahr in Company.settings erfasst. ' +
            'Die Anlage N ist ohne Lohnsteuerbescheinigung leer — bitte unter ' +
            '/dashboard/accounting nachpflegen.',
        )
        .fillColor('#000')
      doc.moveDown(1)
    }

    // Einnahmen
    doc.fontSize(12).font('Helvetica-Bold').text('Einnahmen')
    doc.moveDown(0.3)
    this.renderTable(doc, data.einnahmen, data.totals.bruttoArbeitslohn, 'Einnahmen')
    doc.moveDown(0.8)

    // Werbungskosten
    doc.fontSize(12).font('Helvetica-Bold').text('Werbungskosten')
    doc.moveDown(0.3)
    this.renderTable(
      doc,
      data.werbungskosten,
      data.totals.werbungskostenTotal,
      'Werbungskosten',
    )
    doc.moveDown(0.8)

    // Sonderausgaben
    doc.fontSize(12).font('Helvetica-Bold').text('Sonderausgaben')
    doc.moveDown(0.3)
    this.renderTable(
      doc,
      data.sonderausgaben,
      data.totals.sonderausgabenTotal,
      'Sonderausgaben',
    )
    doc.moveDown(0.8)

    // Außergewöhnliche Belastungen
    doc.fontSize(12).font('Helvetica-Bold').text('Außergewöhnliche Belastungen')
    doc.moveDown(0.3)
    this.renderTable(
      doc,
      data.aussergewoehnlicheBelastungen,
      data.totals.aussergewoehnlicheBelastungenTotal,
      'Außergewöhnliche Belastungen',
    )
    doc.moveDown(1)

    // Einkünfte pill
    doc.fontSize(13).font('Helvetica-Bold')
    const e = data.totals.einkuenfte
    doc
      .fillColor(e >= 0 ? '#047857' : '#b91c1c')
      .text(
        e >= 0
          ? `Einkünfte aus nichtselbständiger Arbeit: ${this.fmtEur(e)} €`
          : `Verlust: ${this.fmtEur(Math.abs(e))} € (negative Einkünfte sind steuerlich ein Vorteil — die Werbungskosten / Sonderausgaben übersteigen den Brutto)`,
      )
      .fillColor('#000')
    doc.moveDown(1)

    // Lohnsteuer info box
    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .text('Lohnsteuer-Anrechnung (zur Information)')
    doc.moveDown(0.3)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Bereits gezahlte Lohnsteuer: ${this.fmtEur(data.lohnsteuerbescheinigung.lohnsteuer)} €`,
      )
    doc.text(
      `Bereits gezahlter Soli: ${this.fmtEur(data.lohnsteuerbescheinigung.soli)} €`,
    )
    doc.text(
      `Bereits gezahlte Kirchensteuer: ${this.fmtEur(data.lohnsteuerbescheinigung.kirchensteuer)} €`,
    )
    doc
      .fontSize(8)
      .fillColor('#666')
      .text(
        'Diese Beträge wurden bereits vom Arbeitgeber ans Finanzamt abgeführt und werden in der Festsetzung auf die berechnete Einkommensteuer angerechnet (Anrechnung gem. § 36 Abs. 2 EStG).',
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
          `de-invoice · Anlage N Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: AnlageNLine[],
    total: number,
    blockLabel: string,
  ): void {
    const tableTop = doc.y
    const colKz = 40
    const colAmount = 420

    // Header
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
