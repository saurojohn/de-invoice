import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { BilanzService, BilanzResult } from './bilanz.service'
import { GuVService, GuVResult } from './guv.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 84: Anhang zum Jahresabschluss (§ 284 HGB).
 *
 * The third part of the Bilanz-pflichtige
 * entity's Jahresabschluss (§ 242 HGB):
 *   1. Bilanz (§ 266 HGB) — tier 81
 *   2. Gewinn- und Verlustrechnung
 *      (§ 275 HGB) — tier 82
 *   3. Anhang (§ 284 HGB) — THIS tier
 *
 * Plus the Anlagenverzeichnis (tier 83) which
 * is a separate attachment for larger
 * companies but often included as a § 284
 * sub-section in practice.
 *
 * The Anhang is a NARRATIVE document: it
 * explains the Bilanz + G+V positions, lists
 * the accounting policies used, and provides
 * context for the "nicht ausgewiesen"
 * positions (the things we can't compute).
 *
 * v1 honestly: we generate a DRAFT Anhang that
 * the Berater reviews + fills in. The
 * auto-generated parts are:
 *   I. Allgemeine Angaben — company info
 *      (name, address, Steuernummer, etc.)
 *   II. Bilanzierungs- und Bewertungsmethoden
 *      — the methods this app uses (hard-coded
 *      list, transparently documents v1's
 *      scope)
 *   III. Erläuterungen zur Bilanz — for each
 *      Bilanz section, a paragraph explaining
 *      what was computed + the note for any
 *      "nicht ausgewiesen" line
 *   IV. Erläuterungen zur G+V — same for G+V
 *   V. Sonstige Pflichtangaben — Marked
 *      "vom Berater zu ergänzen" (Haftungs-
 *      verhältnisse, related-party, events
 *      after balance sheet date, etc.)
 *
 * v2 work (not in scope here):
 *   - Full Anhang für mittelgroße Kapital-
 *     gesellschaften (extended § 284 HGB
 *     disclosure requirements)
 *   - Eigenkapital-Spiegel
 *   - Verbindlichkeiten-Spiegel (by maturity)
 *   - Latente Steuern
 *   - Honorar des Abschlussprüfers
 */

export interface AnhangResult {
  year: number
  companyId: string
  company: {
    name: string
    legalName: string | null
    address: string | null
    taxId: string | null
    vatId: string | null
    registerEntry: string | null
    managingDirector: string | null
  }
  // Each section is a list of paragraphs
  // (strings) the Berater can edit. Auto-
  // generated paragraphs are marked
  // { auto: true, editable: true }. The
  // "vom Berater zu ergänzen" sections are
  // { auto: false, editable: true }.
  sections: {
    title: string
    paragraphs: Array<{ auto: boolean; text: string }>
  }[]
  // For cross-referencing: the Bilanz + G+V
  // position values that the Anhang cites
  // (so the Berater sees the same numbers).
  bilanz: BilanzResult
  guv: GuVResult
  // Counts for transparency
  counts: {
    bilanzNichtAusgewiesen: number
    bilanzComputed: number
    guvNichtAusgewiesen: number
    guvComputed: number
  }
  generatedAt: string
  disclaimer: string
}

@Injectable()
export class AnhangService {
  constructor(
    private prisma: PrismaService,
    private bilanz: BilanzService,
    private guv: GuVService,
  ) {}

  async compute(companyId: string, year: number): Promise<AnhangResult> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) {
      throw new Error('Company nicht gefunden')
    }

    // Pull Bilanz + G+V for cross-referencing
    const bilanz = await this.bilanz.compute(companyId, year)
    const guv = await this.guv.compute(companyId, year)

    // Aggregate counts for transparency
    const bilanzNichtAusgewiesen = bilanz.aktiva
      .concat(bilanz.passiva)
      .reduce((s, sec) => s + sec.nichtAusgewiesen, 0)
    const bilanzComputed = bilanz.aktiva
      .concat(bilanz.passiva)
      .reduce((s, sec) => s + sec.lines.filter((l) => l.amount !== null).length, 0)
    const guvNichtAusgewiesen = guv.revenue.nichtAusgewiesen
      + guv.cost.nichtAusgewiesen
      + guv.financial.nichtAusgewiesen
      + guv.tax.nichtAusgewiesen
    const guvComputed = guv.revenue.lines.filter((l) => l.amount !== null).length
      + guv.cost.lines.filter((l) => l.amount !== null).length
      + guv.financial.lines.filter((l) => l.amount !== null).length
      + guv.tax.lines.filter((l) => l.amount !== null).length

    const sections: AnhangResult['sections'] = [
      this.buildAllgemeineAngaben(company, year),
      this.buildBilanzierungsmethoden(),
      this.buildBilanzErlauterungen(bilanz),
      this.buildGuVErlauterungen(guv),
      this.buildPflichtangaben(),
    ]

    return {
      year,
      companyId,
      company: {
        name: company.name,
        legalName: company.legalName,
        address: this.addressToString(company.address),
        taxId: company.taxId,
        vatId: company.vatId,
        registerEntry: company.registerEntry,
        managingDirector: company.managingDirector,
      },
      sections,
      bilanz,
      guv,
      counts: {
        bilanzNichtAusgewiesen,
        bilanzComputed,
        guvNichtAusgewiesen,
        guvComputed,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Dieser Anhang ist ein vom System automatisch generierter Entwurf. ' +
        'de-invoice v1 erfasst nicht alle Positionen des § 284 HGB — ' +
        'die als "nicht ausgewiesen" markierten Positionen sind vom ' +
        'Berater aus dem SKR03, dem Anlagenverzeichnis und den ' +
        'Steuerbescheiden zu ergänzen. Pflichtangaben nach § 285 HGB ' +
        '(Haftungsverhältnisse, Geschäfte mit nahe stehenden ' +
        'Unternehmen, Ereignisse nach dem Bilanzstichtag, ' +
        'Vorschlag Ergebnisverwendung) sind als "vom Berater zu ' +
        'ergänzen" markiert und müssen vor Einreichung beim ' +
        'Finanzamt / Handelsregister ausgefüllt werden.',
    }
  }

  private buildAllgemeineAngaben(
    company: {
      name: string
      legalName: string | null
      address: any
      taxId: string | null
      vatId: string | null
      registerEntry: string | null
      managingDirector: string | null
    },
    year: number,
  ): AnhangResult['sections'][number] {
    const addressString = this.addressToString(company.address)
    const paragraphs: AnhangResult['sections'][number]['paragraphs'] = [
      {
        auto: true,
        text: `Die Gesellschaft firmiert unter "${company.legalName || company.name}" und hat ihren Sitz in ${
          addressString ? addressString : '— (Adresse nicht hinterlegt)'
        }.`,
      },
      {
        auto: true,
        text: `Der Jahresabschluss wurde zum Stichtag 31.12.${year} nach den Vorschriften des Handelsgesetzbuches (HGB) für Bilanz-pflichtige Gesellschaften aufgestellt.`,
      },
      {
        auto: company.managingDirector !== null,
        text: company.managingDirector
          ? `Geschäftsführung: ${company.managingDirector}.`
          : 'Geschäftsführung: (nicht hinterlegt — vom Berater zu ergänzen).',
      },
      {
        auto: company.taxId !== null,
        text: company.taxId
          ? `Steuernummer: ${company.taxId}.`
          : 'Steuernummer: (nicht hinterlegt — vom Berater zu ergänzen).',
      },
      {
        auto: company.vatId !== null,
        text: company.vatId
          ? `USt-IdNr.: ${company.vatId}.`
          : 'USt-IdNr.: (nicht hinterlegt — vom Berater zu ergänzen).',
      },
      {
        auto: company.registerEntry !== null,
        text: company.registerEntry
          ? `Handelsregistereintrag: ${company.registerEntry}.`
          : 'Handelsregistereintrag: (nicht hinterlegt — vom Berater zu ergänzen).',
      },
    ]
    return {
      title: 'I. Allgemeine Angaben zum Jahresabschluss',
      paragraphs,
    }
  }

  private buildBilanzierungsmethoden(): AnhangResult['sections'][number] {
    return {
      title: 'II. Bilanzierungs- und Bewertungsmethoden',
      paragraphs: [
        {
          auto: true,
          text:
            'Going Concern: Die Bilanz wurde unter der Annahme der Fortführung der ' +
            'Unternehmenstätigkeit aufgestellt (§ 252 Abs. 1 Nr. 2 HGB).',
        },
        {
          auto: true,
          text:
            'Sachanlagen (Anlagevermögen): Die Bilanz erfasst Sachanlagen aus dem ' +
            'Anlagenverzeichnis. Die Abschreibung erfolgt linear nach § 7 Abs. 1 EStG / ' +
            '§ 253 Abs. 1 HGB über die betriebsgewöhnliche Nutzungsdauer. Geleistete ' +
            'Anzahlungen und Anlagen im Bau werden in de-invoice v1 nicht separat ' +
            'erfasst (Position 0500 — nicht ausgewiesen).',
        },
        {
          auto: true,
          text:
            'Forderungen und sonstige Vermögensgegenstände: Ansatz zum Nennwert ' +
            'abzüglich erforderlicher Wertberichtigungen (§ 253 Abs. 4 HGB). ' +
            'Einzelwertberichtigungen werden in de-invoice v1 nicht automatisch ' +
            'ermittelt (vom Berater zu prüfen).',
        },
        {
          auto: true,
          text:
            'Liquide Mittel: Kassenbestand und Bankguthaben werden aus dem Kassenbuch ' +
            'abgeleitet. In v1 werden Kasse und Bank zusammengefasst — eine Aufteilung ' +
            'ist in v2 vorgesehen.',
        },
        {
          auto: true,
          text:
            'Verbindlichkeiten: Ansatz zum Erfüllungsbetrag (§ 253 Abs. 1 HGB). ' +
            'Verb. aus L+L (Position 4000) werden aus den offenen Eingangsrechnungen ' +
            'abgeleitet. Eine Aufteilung nach Restlaufzeit (Verbindlichkeiten-Spiegel) ' +
            'ist in v2 vorgesehen.',
        },
        {
          auto: true,
          text:
            'Kundenguthaben (Position 4500 Passiva): Summe der positiven Kunden- ' +
            'Guthaben aus dem CustomerCreditTransaction-Ledger. Negative ' +
            'Kundenguthaben (Forderungen des Unternehmens gegen den Kunden) sind ' +
            'in den Forderungen aus L+L enthalten.',
        },
        {
          auto: true,
          text:
            'Eigenkapital: Die Bilanz weist das Eigenkapital als Saldoposten aus, der ' +
            'sich aus der Residualgröße (Aktiva − sonstige Passiva) ergibt. Die ' +
            'tatsächlichen Eigenkapital-Positionen (Gezeichnetes Kapital, Rücklagen, ' +
            'Bilanzgewinn) sind vom Berater aus dem SKR03 / Handelsregister zu ' +
            'übernehmen.',
        },
        {
          auto: true,
          text:
            'Rechnungsabgrenzungsposten: Aktive und passive RAP werden in de-invoice ' +
            'v1 nicht erfasst (Positionen 1900 Aktiva / 4900 Passiva — nicht ' +
            'ausgewiesen). Der Berater ergänzt diese aus dem Hauptbuch.',
        },
        {
          auto: true,
          text:
            'Gewinn- und Verlustrechnung: Aufstellung nach § 275 Abs. 2 HGB ' +
            'Gesamtkostenverfahren (GKV). Positionen ohne Datengrundlage (AfA, ' +
            'Bestandsveränderungen, Beteiligungen, Zinserträge, Steuern vom ' +
            'Einkommen und Ertrag) sind als "nicht ausgewiesen" markiert.',
        },
      ],
    }
  }

  private buildBilanzErlauterungen(bilanz: BilanzResult): AnhangResult['sections'][number] {
    const paragraphs: AnhangResult['sections'][number]['paragraphs'] = []
    for (const section of bilanz.aktiva) {
      const computed = section.lines.filter((l) => l.amount !== null)
      const nichtComputed = section.lines.filter((l) => l.amount === null)
      paragraphs.push({
        auto: true,
        text:
          `${section.title}: ${computed.length} Position${computed.length === 1 ? '' : 'en'} ` +
          `ausgewiesen (Summe: ${this.fmtEur(section.subtotal || 0)} EUR), ` +
          `${nichtComputed.length} Position${nichtComputed.length === 1 ? '' : 'en'} nicht ausgewiesen.`,
      })
      for (const l of nichtComputed) {
        paragraphs.push({
          auto: true,
          text: `  · Position ${l.position} (${l.label}): nicht ausgewiesen — ${l.note || 'vom Berater zu ergänzen'}.`,
        })
      }
    }
    for (const section of bilanz.passiva) {
      const computed = section.lines.filter((l) => l.amount !== null)
      const nichtComputed = section.lines.filter((l) => l.amount === null)
      paragraphs.push({
        auto: true,
        text:
          `${section.title}: ${computed.length} Position${computed.length === 1 ? '' : 'en'} ` +
          `ausgewiesen (Summe: ${this.fmtEur(section.subtotal || 0)} EUR), ` +
          `${nichtComputed.length} Position${nichtComputed.length === 1 ? '' : 'en'} nicht ausgewiesen.`,
      })
      for (const l of nichtComputed) {
        paragraphs.push({
          auto: true,
          text: `  · Position ${l.position} (${l.label}): nicht ausgewiesen — ${l.note || 'vom Berater zu ergänzen'}.`,
        })
      }
    }
    paragraphs.push({
      auto: true,
      text:
        `Bilanzgleichung (Aktiva = Passiva): ${bilanz.balanceCheck.balanced ? 'erfüllt' : 'NICHT erfüllt — Differenz: ' + this.fmtEur(bilanz.balanceCheck.diff) + ' EUR'}. ` +
        'Der Saldoposten in der Eigenkapital-Position gleicht die Bilanz aus.',
    })
    return {
      title: 'III. Erläuterungen zur Bilanz (§ 284 Abs. 2 Nr. 1 HGB)',
      paragraphs,
    }
  }

  private buildGuVErlauterungen(guv: GuVResult): AnhangResult['sections'][number] {
    const paragraphs: AnhangResult['sections'][number]['paragraphs'] = []
    for (const section of [guv.revenue, guv.cost, guv.financial, guv.tax]) {
      const computed = section.lines.filter((l) => l.amount !== null)
      const nichtComputed = section.lines.filter((l) => l.amount === null)
      paragraphs.push({
        auto: true,
        text:
          `${section.title}: ${computed.length} Position${computed.length === 1 ? '' : 'en'} ` +
          `ausgewiesen (Summe: ${this.fmtEur(section.subtotal || 0)} EUR), ` +
          `${nichtComputed.length} Position${nichtComputed.length === 1 ? '' : 'en'} nicht ausgewiesen.`,
      })
      for (const l of nichtComputed) {
        paragraphs.push({
          auto: true,
          text: `  · Position ${l.position} (${l.label}): nicht ausgewiesen — ${l.note || 'vom Berater zu ergänzen'}.`,
        })
      }
    }
    paragraphs.push({
      auto: true,
      text:
        `Jahresergebnis: ${guv.totals.jahresueberschuss >= 0 ? 'Jahresüberschuss' : 'Jahresfehlbetrag'} ` +
        `${this.fmtEur(Math.abs(guv.totals.jahresueberschuss))} EUR. ` +
        `Betriebsleistung: ${this.fmtEur(guv.totals.betriebsleistung)} EUR, ` +
        `Betriebsergebnis: ${this.fmtEur(guv.totals.betriebsergebnis)} EUR, ` +
        `Finanzergebnis: ${this.fmtEur(guv.totals.finanzergebnis)} EUR.`,
    })
    paragraphs.push({
      auto: true,
      text:
        'Abgleich mit Bilanz: Die Veränderung des Eigenkapital-Saldopostens der Bilanz ' +
        'zwischen Geschäftsjahr Y-1 und Y entspricht dem Jahresergebnis der G+V, ' +
        'bereinigt um Kapitalbewegungen (Einlagen, Entnahmen, Dividendenzahlungen).',
    })
    return {
      title: 'IV. Erläuterungen zur Gewinn- und Verlustrechnung (§ 284 Abs. 2 Nr. 1 HGB)',
      paragraphs,
    }
  }

  private buildPflichtangaben(): AnhangResult['sections'][number] {
    return {
      title: 'V. Sonstige Pflichtangaben (§ 285 HGB)',
      paragraphs: [
        {
          auto: false,
          text:
            'Haftungsverhältnisse (§ 251 / § 285 Nr. 3 HGB): vom Berater zu ergänzen — ' +
            'Bürgschaften, Garantien, Wechselobligo, Verpflichtungen aus Patronatserklärungen.',
        },
        {
          auto: false,
          text:
            'Geschäfte mit nahe stehenden Unternehmen und Personen (§ 285 Nr. 21 HGB): ' +
            'vom Berater zu ergänzen — wesentliche Geschäfte zu nicht marktüblichen Bedingungen.',
        },
        {
          auto: false,
          text:
            'Ereignisse nach dem Bilanzstichtag (§ 285 Nr. 33 HGB): vom Berater zu ' +
            'ergänzen — Vorgänge von besonderer Bedeutung, die nach dem Bilanzstichtag ' +
            'eingetreten sind und die die Lage der Gesellschaft verändern.',
        },
        {
          auto: false,
          text:
            'Vorschlag für die Ergebnisverwendung (§ 285 Nr. 34 HGB): vom Berater zu ' +
            'ergänzen — z. B. "Der Jahresüberschuss in Höhe von X EUR wird auf neue ' +
            'Rechnung vorgetragen" oder Dividendenzahlung.',
        },
        {
          auto: false,
          text:
            'Honorar des Abschlussprüfers (§ 285 Nr. 17 HGB): vom Berater zu ergänzen, ' +
            'falls eine Prüfung stattgefunden hat (aufgeschlüsselt nach Abschluss- ' +
            'prüfung, anderen Bestätigungsleistungen, Steuerberatung, sonstige Leistungen).',
        },
      ],
    }
  }

  /**
   * Render the Anhang as a multi-page A4 PDF.
   * Each section is a heading + paragraphs in
   * the standard German Geschäftsbericht style
   * (Times-style serif, justified text, 11pt).
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)

    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anhang-${year}.pdf"`,
    )
    doc.pipe(res)

    // Title
    doc
      .fontSize(20)
      .font('Helvetica-Bold')
      .text(`Anhang zum Jahresabschluss ${year}`, { align: 'left' })
    doc.moveDown(0.3)
    doc
      .fontSize(10)
      .font('Helvetica-Oblique')
      .fillColor('#666')
      .text(`§ 284 HGB — ${data.company.legalName || data.company.name}`)
      .fillColor('#000')
    doc.moveDown(1)

    // Counts strip
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor('#666')
      .text(
        `Bilanz: ${data.counts.bilanzComputed} Positionen ausgewiesen, ${data.counts.bilanzNichtAusgewiesen} nicht ausgewiesen · ` +
          `G+V: ${data.counts.guvComputed} Positionen ausgewiesen, ${data.counts.guvNichtAusgewiesen} nicht ausgewiesen`,
      )
      .fillColor('#000')
    doc.moveDown(1)

    // Sections
    for (const section of data.sections) {
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
      doc.text(section.title)
      doc.moveDown(0.3)
      for (const p of section.paragraphs) {
        doc.moveDown(0.2)
        doc.fontSize(10).font('Helvetica')
        if (!p.auto) {
          // Mark Berater-editable paragraphs with
          // a left border in amber to make them
          // visible at a glance.
          doc
            .fillColor('#b45309')
            .text(p.text, { indent: 0, width: 495 })
            .fillColor('#000')
        } else {
          doc.text(p.text, { width: 495 })
        }
      }
      doc.moveDown(0.8)
    }

    // Disclaimer
    doc.moveDown(1)
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
          'de-invoice · Anhang zum Jahresabschluss',
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private firstLine(s: string): string {
    const idx = s.indexOf('\n')
    return idx >= 0 ? s.substring(0, idx) : s
  }

  /**
   * Convert the Company.address Json value
   * (the schema stores it as a flexible JSON
   * blob — typically {street, plz, city,
   * country}) into a one-line string for the
   * PDF. v1: flatten whatever fields are
   * present. v2 could render a multi-line
   * block.
   */
  private addressToString(addr: any): string | null {
    if (!addr) return null
    if (typeof addr === 'string') return addr
    if (typeof addr !== 'object') return null
    const parts: string[] = []
    if (addr.street) parts.push(addr.street)
    if (addr.plz || addr.zip) parts.push(addr.plz || addr.zip)
    if (addr.city) parts.push(addr.city)
    if (addr.country) parts.push(addr.country)
    if (parts.length === 0) return null
    return parts.join(', ')
  }

  private fmtEur(n: number): string {
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }
}
