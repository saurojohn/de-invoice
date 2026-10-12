import { flowFromLeft } from '../../common/pdf-flow'
import { resolveRechtsform, isKapitalgesellschaft } from '../company/rechtsform'
import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Anlage AUS — income from abroad (§ 34d EStG): what of it Germany taxes,
 * what a treaty exempts, and the foreign tax to be credited.
 *
 * Tier 676 — read against § 34c EStG and § 8b KStG (gesetze-im-internet.de,
 * 12.10.2026):
 *
 *   A treaty (DBA) does not mean exemption. § 34c Abs. 6 Satz 2: "Soweit in
 *   einem Abkommen … die Anrechnung einer ausländischen Steuer vorgesehen
 *   ist …". By the treaties' usual content (OECD model, Art. 10, 11, 23)
 *   dividends and interest stay taxable at home, with the source tax
 *   credited; wages, a permanent establishment's profit and income from
 *   land are usually exempted, for persons with Progressionsvorbehalt
 *   (§ 32b EStG). The form assumes that per kind of income and lets every
 *   entry say otherwise — the single treaty decides.
 *
 *   § 8b KStG has nothing to do with a treaty: a corporation's dividends
 *   are left out of its income (Abs. 1), 5 % of them count as expenses
 *   that are not deductible (Abs. 5) — but not when the holding was below
 *   10 % at the beginning of the calendar year (Abs. 4): then they are
 *   taxed in full.
 *
 * Before: `hasDba` alone decided — every income from a treaty country was
 * exempt, a US dividend and US interest too; without a treaty everything
 * was taxed, a GmbH's 30 % holding in a Brazilian company included; § 8b
 * applied "bei Beteiligung ≥ 1%" and only with a treaty; the dividend that
 * was shown as exempt still had its tax credited.
 *
 * Data: Company.settings.anlageAUS[year] = { entries: [{ country,
 * countryName, hasDba, incomeType, grossAmount, foreignTaxPaid,
 * description, methode?, beteiligungAb10? }] }
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

export type AusMethode = 'freistellung' | 'anrechnung'

export interface AusEntry {
  country: string // ISO 3166-1 alpha-2 (e.g. "US", "CH")
  countryName: string // human-readable (e.g. "USA", "Schweiz")
  hasDba: boolean
  incomeType: AusIncomeType
  grossAmount: number // in EUR (after conversion)
  foreignTaxPaid: number // in EUR
  description: string
  /** the method chosen for this entry — '' leaves it to the kind of income */
  methodeGewaehlt: AusMethode | ''
  /** a corporation's dividend: the holding was at least 10 % at the beginning of the year (§ 8b Abs. 4 KStG) */
  beteiligungAb10: boolean
  /** what was applied: the method, or § 8b KStG */
  methode: AusMethode | 'paragraph8b'
}

/** Kinds of income a treaty usually leaves to the state of residence, with credit (OECD model Art. 10, 11, 21). */
const CREDIT_UNDER_TREATY: AusIncomeType[] = ['dividend', 'interest', 'other']

/** The method for an entry: without a treaty always credit; with one, the entry's choice or the usual one. */
export function ausMethode(e: { hasDba: boolean; incomeType: AusIncomeType; methodeGewaehlt?: AusMethode | '' }): AusMethode {
  if (!e.hasDba) return 'anrechnung'
  if (e.methodeGewaehlt === 'freistellung' || e.methodeGewaehlt === 'anrechnung') return e.methodeGewaehlt
  return CREDIT_UNDER_TREATY.includes(e.incomeType) ? 'anrechnung' : 'freistellung'
}

/** What of an entry is taxed here, what is left out, and the foreign tax to be credited. */
export function ausBehandlung(
  e: { hasDba: boolean; incomeType: AusIncomeType; grossAmount: number; foreignTaxPaid: number; methodeGewaehlt?: AusMethode | ''; beteiligungAb10?: boolean },
  isKapg: boolean,
): { methode: AusMethode | 'paragraph8b'; taxable: number; exempt: number; credit: number; p8b: number } {
  if (isKapg && e.incomeType === 'dividend' && e.beteiligungAb10) {
    const p8b = round2(e.grossAmount * PARAGRAPH_8B_PAUSCHALE)
    // nothing of the dividend itself is taxed, so there is no tax to credit against
    return { methode: 'paragraph8b', taxable: p8b, exempt: round2(e.grossAmount - p8b), credit: 0, p8b }
  }
  const methode = ausMethode(e)
  return methode === 'freistellung'
    ? { methode, taxable: 0, exempt: e.grossAmount, credit: 0, p8b: 0 }
    : { methode, taxable: e.grossAmount, exempt: 0, credit: e.foreignTaxPaid, p8b: 0 }
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
    // Taxable in Germany: income under the credit method, and the 5 % of § 8b
    taxable: number
    // left out of a corporation's income by § 8b Abs. 1 KStG (95 % of the dividend)
    paragraph8bFrei: number
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
      'Nach einem DBA freigestellte ausländische Einkünfte (Freistellungsmethode) — bei natürlichen Personen mit Progressionsvorbehalt (§ 32b EStG)',
    source: 'computed',
    note:
      'Die Methode folgt dem üblichen Inhalt der Abkommen: Arbeitslohn, Betriebsstättengewinn und Einkünfte aus Grundbesitz freigestellt, Dividenden und Zinsen steuerpflichtig mit Anrechnung. Das einzelne Abkommen kann abweichen — je Eintrag wählbar.',
  },
  {
    kz: '6',
    label:
      'Im Inland steuerpflichtige ausländische Einkünfte (Anrechnungsmethode; ohne DBA nach § 34c EStG)',
    source: 'computed',
  },
  {
    kz: '13',
    label:
      'Anzurechnende ausländische Steuer (§ 34c Abs. 1 und 6 EStG) — höchstens die deutsche Steuer auf diese Einkünfte, bei einem DBA höchstens die dort zugelassene Quellensteuer',
    source: 'computed',
  },
  {
    kz: '20',
    label:
      '§ 8b KStG: 5 % der steuerfreien Dividenden gelten als nicht abziehbare Betriebsausgaben — nur Kapitalgesellschaften, bei einer Beteiligung von mindestens 10 % zu Beginn des Kalenderjahres',
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
      'Bei ausländischer Betriebsstätte: BWA der Betriebsstätte beifügen, separate Gewinnermittlung nach ausländischem Recht. Der Berater ergänzt manuell.',
  },
  {
    kz: '42',
    label:
      'Einkünfte aus nichtselbständiger Arbeit im Ausland (Nr. 4) — Lohnsteuerbescheinigung ausländischer Arbeitgeber',
    source: 'placeholder',
    note:
      'Bei DBA-Freistellung Progressionsvorbehalt anwenden. Der Berater ergänzt manuell aus der ausländischen Lohnsteuerbescheinigung.',
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
          methodeGewaehlt: (e.methode === 'freistellung' || e.methode === 'anrechnung' ? e.methode : '') as AusMethode | '',
          beteiligungAb10: e.beteiligungAb10 === true,
        }
      })
      .filter(
        (e: Omit<AusEntry, 'methode'>) =>
          e.country || e.countryName || e.description || e.grossAmount > 0,
      )
      .map((e: Omit<AusEntry, 'methode'>) => ({ ...e, methode: ausBehandlung(e, isKapg).methode }))

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
      existing.hasDba = existing.hasDba || e.hasDba
      const b = ausBehandlung(e, isKapg)
      existing.taxablePortion += b.taxable
      existing.exemptPortion += b.exempt
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

    // Totals — each entry by its own treatment
    const grossTotal = entries.reduce((s, e) => s + e.grossAmount, 0)
    const foreignTaxTotal = entries.reduce((s, e) => s + e.foreignTaxPaid, 0)
    const treated = entries.map((e) => ausBehandlung(e, isKapg))
    const progressionsvorbehalt = treated.filter((b) => b.methode === 'freistellung').reduce((s, b) => s + b.exempt, 0)
    const taxable = treated.reduce((s, b) => s + b.taxable, 0)
    const paragraph8b = treated.reduce((s, b) => s + b.p8b, 0)
    const paragraph8bFrei = treated.filter((b) => b.methode === 'paragraph8b').reduce((s, b) => s + b.exempt, 0)
    const anrechnungsbetrag = treated.reduce((s, b) => s + b.credit, 0)

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
        paragraph8bFrei: round2(paragraph8bFrei),
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
        'Diese Vorschau wurde aus Ihren ausländischen Einkünften (erfasst unter Buchhaltung, Anlage AUS) erstellt. ' +
        'Ein Doppelbesteuerungsabkommen bedeutet nicht Freistellung: je nach Abkommen und Art der Einkünfte ' +
        'werden sie freigestellt — bei natürlichen Personen mit Progressionsvorbehalt (§ 32b EStG) — oder ' +
        'bleiben steuerpflichtig, und die ausländische Steuer wird angerechnet (§ 34c Abs. 6 EStG). ' +
        'Angesetzt ist der übliche Inhalt der Abkommen: Dividenden und Zinsen mit Anrechnung, Arbeitslohn, ' +
        'Betriebsstättengewinn und Einkünfte aus Grundbesitz freigestellt; je Eintrag lässt sich die Methode ' +
        'wählen. Ohne Abkommen wird angerechnet (§ 34c Abs. 1 EStG). ' +
        'Die anzurechnende Steuer ist hier die gezahlte ausländische Steuer; anrechenbar ist höchstens die ' +
        'deutsche Steuer, die auf diese Einkünfte entfällt, und bei einem Abkommen höchstens die dort ' +
        'zugelassene Quellensteuer. Für private Kapitalerträge gilt statt § 34c die Anrechnung nach § 32d Abs. 5 EStG. ' +
        'Kapitalgesellschaften: Dividenden bleiben nach § 8b Abs. 1 KStG außer Ansatz, 5 % gelten als nicht ' +
        'abziehbare Betriebsausgaben — nur bei einer Beteiligung von mindestens 10 % zu Beginn des ' +
        'Kalenderjahres (§ 8b Abs. 4 KStG), sonst sind sie voll steuerpflichtig. ' +
        'Beträge in EUR, umgerechnet zum Zeitpunkt der Vereinnahmung. Der Steuerberater prüft das einzelne Abkommen.',
    }
  }

  /**
   * Render the Anlage AUS as a GoBD-style A4 PDF.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = flowFromLeft(new PDFDocument({ size: 'A4', margin: 40 }))
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
