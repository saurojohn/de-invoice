import { resolveRechtsform, isKapitalgesellschaft } from '../company/rechtsform'
import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 110: Anlage AUS — Ausländische Einkünfte
 * (§ 34d EStG).
 *
 * The 9th Anlage form (after S / V / KAP / G / N
 * / R / Kind / SO). For income sourced outside
 * Germany that is taxable in Germany.
 *
 * § 34d EStG enumerates 7 categories:
 *   - Nr. 1: Einkünfte aus Land- und Forstwirtschaft
 *     in foreign countries
 *   - Nr. 2: Einkünfte aus Gewerbebetrieb through
 *     a foreign Betriebsstätte
 *   - Nr. 3: Einkünfte aus selbständiger Arbeit
 *     performed abroad
 *   - Nr. 4: Einkünfte aus nichtselbständiger
 *     Arbeit (employment abroad — Lohnsteuer-
 *     bescheinigung country)
 *   - Nr. 5: Einkünfte aus Kapitalvermögen
 *     (foreign dividends / interest)
 *   - Nr. 6: Einkünfte aus Vermietung und
 *     Verpachtung (foreign real estate)
 *   - Nr. 7: Sonstige Einkünfte with foreign
 *     source (§ 22 + § 23 EStG)
 *
 * Two key concepts (§ 34d EStG):
 *
 *   1. DBA (Doppelbesteuerungsabkommen) — a
 *      bilateral tax treaty between two countries.
 *      The treaty decides WHICH country has the
 *      primary right to tax + which method
 *      applies:
 *
 *      - Freistellung (exemption method): the
 *        other country exempts, so only the
 *        source country taxes. Germany exempts
 *        the foreign income BUT the income still
 *        affects the German Steuersatz via
 *        Progressionsvorbehalt (§ 32b EStG).
 *        Typical: employment income, business
 *        income for most DBA countries.
 *
 *      - Anrechnung (credit method): both
 *        countries tax, but the country of
 *        residence credits the foreign tax paid
 *        against its own tax liability. Typical:
 *        passive income (dividends, interest,
 *        rental) in DBA countries with
 *        Anrechnungs-clauses, AND all income
 *        from non-DBA countries.
 *
 *   2. § 8b KStG (only for KapG = GmbH/AG):
 *      Dividends from foreign corporations are
 *      95% tax-exempt (5% non-deductible). This
 *      overrides any DBA Anrechnung for dividends
 *      at the corporate level.
 *
 * v1 covers:
 *   (a) Multiple entries per year, one per
 *       (country + income type) pair.
 *   (b) For each entry: gross amount in EUR +
 *       foreign tax paid in EUR + hasDba flag.
 *   (c) Per-entry math:
 *       - hasDba=true: Progressionsvorbehalt
 *         (add to Steuersatz-affecting sum, NOT
 *         to taxable income)
 *       - hasDba=false (or no DBA clause):
 *         Anrechnung — foreign tax credited
 *         against the German tax on that
 *         portion. v1 simplification: the
 *         Anrechnungsbetrag is the foreign tax
 *         paid (capped at the pro-rata German
 *         tax on that income at the user's
 *         marginal rate, which we don't know
 *         here — the user enters a guess or
 *         the Berater calculates in the
 *         Festsetzung).
 *       - KapG dividends (§ 8b KStG): 95% of
 *         gross is exempt, 5% non-deductible.
 *   (d) BMF Vordruck Anlage AUS 2024 Kz:
 *       - Kz 5: Sum of DBA-freigestellte income
 *         (Progression)
 *       - Kz 6: Sum of taxable foreign income
 *         (Anrechnung)
 *       - Kz 13: Anrechnungsbetrag (foreign tax
 *         credit)
 *       - Kz 20: § 8b KStG pauschale (5%
 *         non-deductible for KapG)
 *
 * v1 data model: Company.settings.anlageAUS[year] = {
 *   entries: Array<{ country, countryName, hasDba,
 *     incomeType, grossAmount, foreignTaxPaid,
 *     description }>
 * }
 *
 * The opt-in flag `Company.settings.anlageAus === true`
 * gates inclusion. v1 also auto-detects entries
 * (length > 0).
 */

export type AusIncomeType =
  | 'dividend'
  | 'interest'
  | 'rental'
  | 'employment'
  | 'business'
  | 'selfEmployment'
  | 'agriculture'
  | 'other'

export interface AusEntry {
  country: string // ISO 3166-1 alpha-2 (e.g. "US", "CH")
  countryName: string // human-readable (e.g. "USA", "Schweiz")
  hasDba: boolean
  incomeType: AusIncomeType
  grossAmount: number // in EUR (after conversion)
  foreignTaxPaid: number // in EUR
  description: string
}

export interface AnlageAUSLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

export interface AnlageAUSResult {
  year: number
  companyId: string
  rechtsform: string // for § 8b KStG check
  isKapg: boolean
  entries: AusEntry[]
  perCountry: Array<{
    country: string
    countryName: string
    hasDba: boolean
    count: number
    grossTotal: number
    foreignTaxTotal: number
    taxablePortion: number
    exemptPortion: number
  }>
  lines: AnlageAUSLine[]
  totals: {
    grossTotal: number
    foreignTaxTotal: number
    // Progressionsvorbehalt: sum of DBA-freigestellte income
    // (NOT taxed in Germany, but affects Steuersatz for
    // the rest of the income)
    progressionsvorbehalt: number
    // Taxable in Germany (Anrechnung method)
    taxable: number
    // § 8b KStG: 5% non-deductible portion of KapG dividends
    paragraph8b: number
    // Foreign tax credit (Anrechnungsbetrag)
    anrechnungsbetrag: number
  }
  counts: {
    hasEntries: boolean
    hasDbaEntries: boolean
    hasNonDbaEntries: boolean
    countryCount: number
  }
  generatedAt: string
  disclaimer: string
}

// § 8b KStG: 5% of dividends are non-deductible
// (95% exempt, 5% taxable at corporate level)
const PARAGRAPH_8B_PAUSCHALE = 0.05

const LINES: Array<{
  kz: string
  label: string
  source: 'computed' | 'placeholder'
  note?: string
}> = [
  {
    kz: '5',
    label:
      'Summe der nach DBA freigestellten ausländischen Einkünfte (§ 34d EStG + Progressionsvorbehalt nach § 32b EStG)',
    source: 'computed',
  },
  {
    kz: '6',
    label:
      'Summe der im Inland steuerpflichtigen ausländischen Einkünfte (Anrechnungsmethode, § 34d Abs. 1 EStG)',
    source: 'computed',
  },
  {
    kz: '13',
    label:
      'Anrechnungsbetrag ausländischer Steuer (§ 34c Abs. 1 EStG / DBA) — die im Ausland gezahlte Steuer wird auf die deutsche Einkommensteuer angerechnet',
    source: 'computed',
  },
  {
    kz: '20',
    label:
      '§ 8b KStG Pauschale (5% nicht abziehbare Betriebsausgaben) — nur für KapG (GmbH / AG / KGaA / UG). Bei Beteiligung ≥ 1% an ausländischer Kapitalgesellschaft.',
    source: 'computed',
  },
  {
    kz: '32',
    label:
      'Einkünfte aus ausländischen Dividenden (Nr. 5) — thesauriert oder ausgeschüttet',
    source: 'computed',
  },
  {
    kz: '34',
    label:
      'Einkünfte aus ausländischen Zinsen (Nr. 5) — Bankguthaben, Anleihen, etc.',
    source: 'computed',
  },
  {
    kz: '40',
    label:
      'Einkünfte aus ausländischem Gewerbebetrieb (Nr. 2) — durch ausländische Betriebsstätte',
    source: 'placeholder',
    note:
      'Bei ausländischer Betriebsstätte: BWA der Betriebsstätte beifügen, separate Gewinnermittlung nach ausländischem Recht. v1: Berater ergänzt manuell. v2: Import ausländischer Buchhaltung (DATEV-kompatibel).',
  },
  {
    kz: '42',
    label:
      'Einkünfte aus nichtselbständiger Arbeit im Ausland (Nr. 4) — Lohnsteuerbescheinigung ausländischer Arbeitgeber',
    source: 'placeholder',
    note:
      'Bei DBA-Freistellung Progressionsvorbehalt anwenden. v1: Berater ergänzt manuell aus der ausländischen Lohnsteuerbescheinigung.',
  },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class AnlageAUSService {
  constructor(private prisma: PrismaService) {}

  /**
   * Compute the Anlage AUS for the year.
   */
  async compute(companyId: string, year: number): Promise<AnlageAUSResult> {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true, legalName: true, name: true, rechtsform: true },
    })
    const settings = (company?.settings as any) || {}
    // Tier 441: the company's legal form (company/rechtsform.ts). Was the
    // settings value or the legal name tested with /^(GmbH|…)/ — "Muster
    // GmbH" does not START with GmbH, so no GmbH got the § 8b KStG rule.
    const resolved = company ? resolveRechtsform(company) : { rechtsform: null }
    const rechtsform = resolved.rechtsform ?? ''
    const isKapg = isKapitalgesellschaft(resolved.rechtsform)

    const anlageAusAll = (settings.anlageAUS as any) || {}
    const yearData = anlageAusAll[year] || {}

    // Normalize entries
    const rawEntries = Array.isArray(yearData.entries) ? yearData.entries : []
    const entries: AusEntry[] = rawEntries
      .filter((e: any) => e && typeof e === 'object')
      .map((e: any) => {
        const incomeType: AusIncomeType = (() => {
          const t = String(e.incomeType || 'other')
          if (
            [
              'dividend',
              'interest',
              'rental',
              'employment',
              'business',
              'selfEmployment',
              'agriculture',
              'other',
            ].includes(t)
          ) {
            return t as AusIncomeType
          }
          return 'other'
        })()
        return {
          country: String(e.country || '').trim().toUpperCase().slice(0, 2),
          countryName: String(e.countryName || '').trim(),
          hasDba: e.hasDba === true,
          incomeType,
          grossAmount: Number(e.grossAmount) || 0,
          foreignTaxPaid: Number(e.foreignTaxPaid) || 0,
          description: String(e.description || '').trim(),
        }
      })
      .filter(
        (e: AusEntry) =>
          e.country || e.countryName || e.description || e.grossAmount > 0,
      )

    // Per-country aggregation
    const countryMap = new Map<
      string,
      {
        country: string
        countryName: string
        hasDba: boolean
        count: number
        grossTotal: number
        foreignTaxTotal: number
        taxablePortion: number
        exemptPortion: number
      }
    >()
    for (const e of entries) {
      const key = e.country || 'XX'
      const existing = countryMap.get(key) || {
        country: e.country,
        countryName: e.countryName || e.country,
        hasDba: e.hasDba,
        count: 0,
        grossTotal: 0,
        foreignTaxTotal: 0,
        taxablePortion: 0,
        exemptPortion: 0,
      }
      existing.count += 1
      existing.grossTotal += e.grossAmount
      existing.foreignTaxTotal += e.foreignTaxPaid
      // Per-entry: if hasDba, the income is exempt
      // (Progressionsvorbehalt). If not hasDba, the
      // income is taxable in Germany with Anrechnung.
      // § 8b KStG for KapG dividends: 5% taxable, 95% exempt
      if (e.hasDba) {
        // DBA-Freistellung: exempt from German income tax
        // (Progressionsvorbehalt applies separately)
        if (isKapg && e.incomeType === 'dividend') {
          // § 8b KStG: 5% taxable (5% of gross)
          existing.taxablePortion += round2(
            e.grossAmount * PARAGRAPH_8B_PAUSCHALE,
          )
          existing.exemptPortion += round2(
            e.grossAmount * (1 - PARAGRAPH_8B_PAUSCHALE),
          )
        } else {
          // Pure DBA exemption
          existing.exemptPortion += e.grossAmount
        }
      } else {
        // No DBA → Anrechnung: fully taxable in Germany,
        // foreign tax credited
        existing.taxablePortion += e.grossAmount
      }
      countryMap.set(key, existing)
    }
    const perCountry = Array.from(countryMap.values()).map((c) => ({
      country: c.country,
      countryName: c.countryName,
      hasDba: c.hasDba,
      count: c.count,
      grossTotal: round2(c.grossTotal),
      foreignTaxTotal: round2(c.foreignTaxTotal),
      taxablePortion: round2(c.taxablePortion),
      exemptPortion: round2(c.exemptPortion),
    }))

    // Totals
    const grossTotal = entries.reduce((s, e) => s + e.grossAmount, 0)
    const foreignTaxTotal = entries.reduce(
      (s, e) => s + e.foreignTaxPaid,
      0,
    )
    const progressionsvorbehalt = perCountry
      .filter((c) => c.hasDba)
      .reduce((s, c) => s + c.exemptPortion, 0)
    const taxable = perCountry
      .filter((c) => !c.hasDba)
      .reduce((s, c) => s + c.grossTotal, 0)
    const paragraph8b = isKapg
      ? entries
          .filter(
            (e) => e.hasDba && e.incomeType === 'dividend',
          )
          .reduce(
            (s, e) =>
              s + round2(e.grossAmount * PARAGRAPH_8B_PAUSCHALE),
            0,
          )
      : 0
    // Anrechnungsbetrag: sum of foreign tax paid on
    // non-DBA (Anrechnung) entries + KapG dividend entries
    // that are still subject to Anrechnung despite § 8b
    // (since § 8b only applies to KapG for dividends ≥ 1%
    // participation, otherwise treat as Anrechnung)
    const anrechnungsbetrag = entries
      .filter((e) => !e.hasDba || (!isKapg && e.incomeType === 'dividend'))
      .reduce((s, e) => s + e.foreignTaxPaid, 0)

    // Build BMF Vordruck Kz lines
    const lines: AnlageAUSLine[] = LINES.map((d) => {
      let amount = 0
      if (d.kz === '5') amount = round2(progressionsvorbehalt)
      else if (d.kz === '6') amount = round2(taxable)
      else if (d.kz === '13') amount = round2(anrechnungsbetrag)
      else if (d.kz === '20') amount = round2(paragraph8b)
      else if (d.kz === '32') {
        // Foreign dividends: sum of all dividend entries
        amount = round2(
          entries
            .filter((e) => e.incomeType === 'dividend')
            .reduce((s, e) => s + e.grossAmount, 0),
        )
      } else if (d.kz === '34') {
        // Foreign interest: sum of all interest entries
        amount = round2(
          entries
            .filter((e) => e.incomeType === 'interest')
            .reduce((s, e) => s + e.grossAmount, 0),
        )
      }
      const line: AnlageAUSLine = {
        kennziffer: d.kz,
        label: d.label,
        amount,
        source: d.source,
      }
      if (d.note) line.note = d.note
      return line
    })

    return {
      year,
      companyId,
      rechtsform,
      isKapg,
      entries,
      perCountry,
      lines,
      totals: {
        grossTotal: round2(grossTotal),
        foreignTaxTotal: round2(foreignTaxTotal),
        progressionsvorbehalt: round2(progressionsvorbehalt),
        taxable: round2(taxable),
        paragraph8b: round2(paragraph8b),
        anrechnungsbetrag: round2(anrechnungsbetrag),
      },
      counts: {
        hasEntries: entries.length > 0,
        hasDbaEntries: entries.some((e) => e.hasDba),
        hasNonDbaEntries: entries.some((e) => !e.hasDba),
        countryCount: countryMap.size,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihren ausländischen ' +
        'Einkünften (Company.settings.anlageAUS[year]) + dem ' +
        'DBA-Status pro Land generiert. § 34d EStG unterscheidet 7 ' +
        'Kategorien (Nr. 1-7) von Auslandseinkünften. Bei DBA-Freistellung ' +
        'greift der Progressionsvorbehalt nach § 32b EStG: die Einkünfte ' +
        'sind steuerfrei, erhöhen aber den Steuersatz für die übrigen ' +
        'Einkünfte. Bei Anrechnung (kein DBA oder DBA mit Anrechnungs- ' +
        'klausel) wird die ausländische Steuer auf die deutsche Einkommen- ' +
        'steuer angerechnet (Anrechnungsbetrag = foreignTaxPaid). ' +
        '§ 8b KStG (nur für KapG): 95% der ausländischen Dividenden sind ' +
        'steuerfrei, 5% nicht abziehbare Betriebsausgaben (bei Beteiligung ' +
        '≥ 1% an ausländischer Kapitalgesellschaft). v1: Der Anrechnungs- ' +
        'betrag ist die tatsächlich gezahlte ausländische Steuer (nicht ' +
        'gedeckelt). Die tatsächliche deutsche Einkommensteuer auf den ' +
        'steuerpflichtigen Anteil (Kz 6) hängt vom Grenzsteuersatz ab — ' +
        'der Berater prüft im Festsetzungs-Bescheid, ob die ausländische ' +
        'Steuer den deutschen Anteil übersteigt (ggf. keine Anrechnung, ' +
        'sondern nur Abzug als Betriebsausgabe nach § 34c Abs. 2 EStG). ' +
        'Beträge in EUR (Umrechnungskurs zum Zeitpunkt der Vereinnahmung, ' +
        'siehe BMF-Schreiben). v2: automatischer Wechselkurs-Lookup + ' +
        'DBA-Tabelle pro Land.',
    }
  }

  /**
   * Render the Anlage AUS as a GoBD-style A4 PDF.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-AUS-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage AUS ${year} — VORSCHAU`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Ausländische Einkünfte (§ 34d EStG) — ${company?.name || companyId}` +
          (data.rechtsform ? ` (Rechtsform: ${data.rechtsform})` : ''),
      )
      .moveDown(1)

    if (!data.counts.hasEntries) {
      doc
        .fontSize(10)
        .font('Helvetica-Oblique')
        .fillColor('#b45309')
        .text(
          '⚠ Keine ausländischen Einkünfte für dieses Jahr erfasst. ' +
            'Tragen Sie unten Ihre Einkünfte aus dem Ausland ein (Dividenden, ' +
            'Zinsen, Mieteinnahmen aus ausländischen Immobilien, etc.). ' +
            'Für jedes Land eine Zeile mit Land, Einkunftsart, Bruttobetrag, ' +
            'gezahlter ausländischer Steuer und DBA-Status.',
        )
        .fillColor('#000')
      doc.moveDown(1)
    }

    // Per-country table
    if (data.perCountry.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Ausländische Einkünfte pro Land')
      doc.moveDown(0.3)
      doc.fontSize(8).font('Helvetica')
      for (const c of data.perCountry) {
        doc.text(
          `• ${c.countryName || c.country} (${c.country})${c.hasDba ? ' [DBA-Freistellung]' : ' [Anrechnung]'} — ` +
            `${c.count} Eintrag/Einträge, Brutto: ${this.fmtEur(c.grossTotal)} €, ` +
            `Steuerpflichtig (DE): ${this.fmtEur(c.taxablePortion)} €, ` +
            `Steuerfrei (Progressionsvorbehalt): ${this.fmtEur(c.exemptPortion)} €`,
        )
      }
      doc.moveDown(1)
    }

    // BMF Vordruck table
    doc.fontSize(12).font('Helvetica-Bold').text('BMF Vordruck Anlage AUS 2024 — Kennziffern')
    doc.moveDown(0.3)
    this.renderTable(doc, data.lines, data.totals)
    doc.moveDown(1)

    // Summary
    doc.fontSize(13).font('Helvetica-Bold')
    doc.text(
      `Σ Brutto: ${this.fmtEur(data.totals.grossTotal)} €  |  ` +
        `Σ Anrechnung: ${this.fmtEur(data.totals.anrechnungsbetrag)} €  |  ` +
        `Σ Einkünfte (DE-steuerpflichtig): ${this.fmtEur(data.totals.taxable)} €`,
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
          `de-invoice · Anlage AUS Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: AnlageAUSLine[],
    totals: AnlageAUSResult['totals'],
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
    doc.text('Steuerpflichtige Einkünfte (DE)', colKz + 35, doc.y, {
      width: 320,
    })
    doc.text(this.fmtEur(totals.taxable), colAmount, doc.y, {
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
