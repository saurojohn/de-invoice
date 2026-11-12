import { flowFromLeft } from '../../common/pdf-flow'
import { prepaymentsOfYear } from './prepayments-of-year'
import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { AnlageGService } from './anlage-g.service'
import { eingetragenerVortrag, ersterBuchjahr, gewstVerlustProzent, verlustKonto, type VerlustKonto } from './verlustvortrag'
import PDFDocument from 'pdfkit'

/**
 * Tier 106: GewSt-Erklärung (Gewerbesteuererklärung,
 * BMF Vordruck GewSt 1A 2024).
 *
 * The standalone trade tax return. Sits between
 * the Anlage series and the HGB reports in the
 * Berater packager — same as UStJA (Tier 105) but
 * for trade tax instead of VAT.
 *
 * v1 architecture: delegates the gewerbeertrag
 * computation to the existing AnlageGService
 * (which already computes § 8/9 GewStG hinzu/
 * kürzungen, the 24 500 EUR Freibetrag § 11 Abs. 1
 * GewStG, and the gewerbeertragNachFreibetrag).
 * We then add the BMF Vordruck GewSt 1A fields:
 *
 *   Kz 5   — Steuermessbetrag
 *           = gewerbeertragNachFreibetrag × 0.035
 *   Kz 7   — Hebesatz (default 400, configurable
 *           per Gemeinde — Köln 470, München 490,
 *           Münster 400, etc.)
 *   Kz 10  — festzusetzende Gewerbesteuer
 *           = Kz 5 × Kz 7 / 100
 *   Kz 11  — Summe Vorauszahlungen (Q1-Q4)
 *   Kz 12  — Differenz (Kz 10 - Kz 11)
 *           — positive = Restzahlung, negative
 *           = Erstattung
 *
 * Vorauszahlungen default to 0 (Berater enters
 * the actual Vorauszahlungen from the 4
 * Quartalsbescheide via PUT /gewst/settings).
 *
 * KapG-specific note: For a GmbH, the same
 * Gewerbeertrag is also used in KSt 1 (tier 102)
 * — the KSt-Anrechnung cap of 3.8 × Messbetrag
 * is computed on Kz 5. Same source of truth.
 */
export interface GewstLine {
  kennziffer: string
  label: string
  amount?: number
  percent?: number
  source?: 'computed' | 'placeholder' | 'manual'
  note?: string
}

export interface GewstResult {
  year: number
  companyId: string
  periodLabel: string
  hebesatz: number
  freibetrag: number
  gewerbeertrag: number
  gewerbeertragNachFreibetrag: number
  /** Tier 837: the Gewerbeverlust carried in, deducted, carried on (§ 10a GewStG) */
  fehlbetrag: VerlustKonto
  lines: GewstLine[]
  vorauszahlungen: {
    q1: number
    q2: number
    q3: number
    q4: number
    total: number
  }
  totals: {
    gewerbesteuerMesszahl: number // 0.035
    steuermessbetrag: number // Kz 5
    hebesatz: number // Kz 7
    festzusetzendeGewerbesteuer: number // Kz 10
    vorauszahlungenTotal: number // Kz 11
    differenz: number // Kz 12 (10 - 11)
  }
  counts: {
    hasGewerbeertrag: boolean
    hasVorauszahlungen: boolean
  }
  generatedAt: string
  disclaimer: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class GewstService {
  constructor(
    private prisma: PrismaService,
    private anlageG: AnlageGService,
  ) {}

  async compute(companyId: string, year: number): Promise<GewstResult> {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    // Read the underlying Anlage G computation —
    // gewerbeertrag, gewerbeertragNachFreibetrag,
    // hebesatz, etc. The AnlageGService already
    // applies the § 8/9 GewStG hinzu/kürzungen +
    // the 24 500 EUR Freibetrag.
    const anlageG = await this.anlageG.compute(companyId, year)

    // Read the Vorauszahlungen from settings
    // (default 0 — the Berater enters the actual
    // Q1-Q4 Vorauszahlungen from the quarterly
    // Bescheide). Schema:
    //   Company.settings.gewstVorauszahlungen[year] = {
    //     q1, q2, q3, q4: number
    //   }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    const settings = (company?.settings as any) || {}
    const vorauszahlungenAll =
      (settings.gewstVorauszahlungen as any) || {}
    const vorauszahlungenYear = vorauszahlungenAll[year] || {}
    const vq1 = Number(vorauszahlungenYear.q1) || 0
    const vq2 = Number(vorauszahlungenYear.q2) || 0
    const vq3 = Number(vorauszahlungenYear.q3) || 0
    const vq4 = Number(vorauszahlungenYear.q4) || 0
    // Tier 815: Kz 11 is what was paid for the year (the GewSt prepayments
    // booked), else the four amounts entered — as KSt 1 and the Bilanz count it
    const pre = (await prepaymentsOfYear(this.prisma, companyId, year, settings, (await this.prisma.company.findUnique({ where: { id: companyId }, select: { bundesland: true } }))?.bundesland)).gewst
    const vorauszahlungenTotal = pre.used
    const hasVorauszahlungen = vorauszahlungenTotal !== 0

    // ── BMF Vordruck GewSt 1A lines ──────────────
    const messzahl = 0.035
    const hebesatz = anlageG.totals.hebesatz // default 400 from AnlageG
    // Tier 837: less the Fehlbetrag of the years before (§ 10a GewStG) — before the
    // rounding and the Freibetrag of § 11 Abs. 1. Was: the Gewerbeertrag of the
    // year alone, a loss year's Fehlbetrag forgotten the year after.
    const fehlbetrag = verlustKonto(
      ...(await this.fehlbetragIn(companyId, year, settings)),
      anlageG.totals.gewerbeertrag,
      gewstVerlustProzent(year),
    )
    const gewerbeertragNachFreibetrag = Math.max(
      0,
      Math.floor((anlageG.totals.gewerbeertrag - fehlbetrag.abzug) / 100) * 100 - anlageG.totals.freibetrag,
    )
    const steuermessbetrag = round2(gewerbeertragNachFreibetrag * messzahl)
    const festzusetzendeGewSt = round2(steuermessbetrag * (hebesatz / 100))
    const differenz = round2(festzusetzendeGewSt - vorauszahlungenTotal)

    const lines: GewstLine[] = [
      {
        kennziffer: '5',
        label: 'Steuermessbetrag (Gewerbeertrag nach Freibetrag × 0.035)',
        amount: steuermessbetrag,
        source: 'computed',
      },
      {
        kennziffer: '7',
        label: 'Hebesatz der Gemeinde (400 %, solange kein anderer eingetragen ist)',
        percent: hebesatz,
        source: 'computed',
      },
      {
        kennziffer: '10',
        label: 'Festzusetzende Gewerbesteuer (Kz 5 × Kz 7 / 100)',
        amount: festzusetzendeGewSt,
        source: 'computed',
      },
      {
        kennziffer: '11',
        label: pre.source === 'paid' ? 'Summe Vorauszahlungen (gezahlt, aus den gebuchten Zahlungen)' : 'Summe Vorauszahlungen (Q1 + Q2 + Q3 + Q4, manuell vom Berater)',
        amount: round2(vorauszahlungenTotal),
        source: pre.source === 'paid' ? 'computed' : hasVorauszahlungen ? 'manual' : 'placeholder',
        note: pre.source === 'paid'
          ? pre.entered && Math.abs(pre.entered - pre.paid) > 0.005
            ? `Die für ${year} gebuchten Gewerbesteuer-Vorauszahlungen — eingetragen sind ${pre.entered.toFixed(2)} €.`
            : `Die für ${year} gebuchten Gewerbesteuer-Vorauszahlungen.`
          : hasVorauszahlungen
            ? 'Eingetragen; keine Zahlung gebucht.'
            : 'Der Berater trägt die tatsächlichen Vorauszahlungen aus den 4 Quartalsbescheiden auf der Seite Buchhaltung unter Gewerbesteuer ein.',
      },
      {
        kennziffer: '12',
        label: 'Differenz (Kz 10 - Kz 11) — positiv = Restzahlung, negativ = Erstattung',
        amount: differenz,
        source: 'computed',
      },
    ]

    return {
      year,
      companyId,
      periodLabel: `01.01.${year} – 31.12.${year}`,
      hebesatz,
      freibetrag: anlageG.totals.freibetrag,
      gewerbeertrag: anlageG.totals.gewerbeertrag,
      gewerbeertragNachFreibetrag,
      fehlbetrag,
      lines,
      vorauszahlungen: {
        q1: vq1,
        q2: vq2,
        q3: vq3,
        q4: vq4,
        total: round2(vorauszahlungenTotal),
      },
      totals: {
        gewerbesteuerMesszahl: messzahl,
        steuermessbetrag,
        hebesatz,
        festzusetzendeGewerbesteuer: festzusetzendeGewSt,
        vorauszahlungenTotal: round2(vorauszahlungenTotal),
        differenz,
      },
      counts: {
        hasGewerbeertrag: anlageG.totals.gewerbeertrag !== 0,
        hasVorauszahlungen,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        `Diese Vorschau wurde automatisch aus der Anlage-G-Berechnung (${year}) + ` +
        'den vom Berater eingetragenen Vorauszahlungen (Q1-Q4) generiert. ' +
        'BMF Vordruck GewSt 1A 2024: Kz 5 (Steuermessbetrag) = Gewerbeertrag ' +
        'nach Freibetrag × 0.035; Kz 7 (Hebesatz) = Gemeinde-Hebesatz ' +
        '(400, solange kein anderer eingetragen ist — änderbar auf der Seite ' +
        'Buchhaltung unter Gewerbesteuer); Kz 10 ' +
        '(festzusetzende Gewerbesteuer) = Kz 5 × Kz 7 / 100; Kz 11 (Summe ' +
        'Vorauszahlungen) = Q1 + Q2 + Q3 + Q4 aus den 4 Quartalsbescheiden; ' +
        'Kz 12 (Differenz) = Kz 10 - Kz 11 — positiv = Restzahlung, negativ = ' +
        'Erstattung. Vereinfachtes Modell ohne Zerlegung nach § 8/9 ' +
        'GewStG Hinzurechnungen/Kürzungen in der Vordruck-Struktur — die ' +
        '§ 8/9-Korrekturen sind bereits in Anlage G angewendet, das Ergebnis ' +
        'fließt hier 1:1 in den Steuermessbetrag ein. Berater verifiziert: ' +
        '(a) den Hebesatz der Gemeinde (er steht im Gewerbesteuerbescheid); ' +
        '(b) die tatsächlichen ' +
        'Vorauszahlungen aus den 4 Quartalsbescheiden — diese werden NICHT ' +
        'vom System geschätzt; (c) die § 11 Abs. 1 GewStG Freibetrag-Logik ' +
        '(24.500 EUR für Einzelunternehmen + PersG; 0 für KapG); (d) die ' +
        'Anrechnung der Gewerbesteuer auf die Einkommensteuer (§ 35 EStG) — ' +
        'sie steht nur Einzelunternehmern und den Gesellschaftern einer ' +
        'Personengesellschaft zu, eine Kapitalgesellschaft rechnet nichts an.',
    }
  }

  /**
   * Tier 837 — the Fehlbetrag carried into `year`: the Bescheid's figure
   * entered (settings.verlustvortrag[year].gewst), else what the form of the
   * year before carried on, back to the first year with books, else 0.
   */
  private async fehlbetragIn(companyId: string, year: number, settings: Record<string, any>): Promise<[number, VerlustKonto['quelle']]> {
    const entered = eingetragenerVortrag(settings, year, 'gewst')
    if (entered !== null) return [entered, 'bescheid']
    const first = await ersterBuchjahr(this.prisma, companyId)
    if (first === null || year - 1 < first || year - 1 < 2000) return [0, 'keiner']
    const ende = (await this.compute(companyId, year - 1)).fehlbetrag.ende
    return ende > 0 ? [ende, 'berechnet'] : [0, 'keiner']
  }

  async renderPdf(companyId: string, year: number, res: any): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })

    const doc = flowFromLeft(new PDFDocument({ size: 'A4', margin: 40 }))
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="GewSt-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Gewerbesteuererklärung ${year} — VORSCHAU`, {
        align: 'left',
      })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `GewSt gem. BMF Vordruck GewSt 1A 2024 — ${company?.name || companyId} | Zeitraum ${data.periodLabel} | Hebesatz ${data.hebesatz} %`,
      )
      .moveDown(1)

    // Vorauszahlungen table
    doc.fontSize(12).font('Helvetica-Bold').text('Vorauszahlungen (Quartal)')
    doc.moveDown(0.3)
    this.renderVorauszahlungenTable(doc, data.vorauszahlungen)
    doc.moveDown(0.8)

    // BMF Vordruck lines
    doc.fontSize(12).font('Helvetica-Bold').text('BMF Vordruck GewSt 1A — Kennziffern')
    doc.moveDown(0.3)
    this.renderLinesTable(doc, data.lines)
    doc.moveDown(0.8)

    // Tier 837: the Gewerbeverlust of the years before (§ 10a GewStG)
    const fb = data.fehlbetrag
    if (fb.anfang > 0 || fb.zugang > 0) {
      doc.fontSize(10).font('Helvetica').text(
        `Gewerbeertrag ${this.fmtEur(data.gewerbeertrag)} € — Fehlbetrag aus Vorjahren (§ 10a GewStG) ` +
          `${this.fmtEur(fb.anfang)} €${fb.quelle === 'bescheid' ? ' (laut Bescheid)' : ''}, abgezogen ${this.fmtEur(fb.abzug)} €, ` +
          `vorzutragen zum 31.12.${data.year}: ${this.fmtEur(fb.ende)} €`,
      )
      doc.moveDown(0.8)
    }

    // Summary
    doc.fontSize(13).font('Helvetica-Bold')
    doc.text(
      `Festzusetzende GewSt (Kz 10): ${this.fmtEur(data.totals.festzusetzendeGewerbesteuer)} €  |  ` +
        `Vorauszahlungen (Kz 11): ${this.fmtEur(data.totals.vorauszahlungenTotal)} €  |  ` +
        `Differenz (Kz 12): ${this.fmtEur(data.totals.differenz)} €`,
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
          `de-invoice · GewSt-Erklärung Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderVorauszahlungenTable(
    doc: PDFKit.PDFDocument,
    vq: GewstResult['vorauszahlungen'],
  ): void {
    const tableTop = doc.y
    const colLabel = 50
    const colValue = 350

    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Quartal', colLabel, tableTop)
    doc.text('Betrag (€)', colValue, tableTop, { width: 200, align: 'right' })
    doc.moveDown(0.3)
    doc
      .moveTo(colLabel, doc.y)
      .lineTo(555, doc.y)
      .strokeColor('#333')
      .lineWidth(0.5)
      .stroke()
    doc.moveDown(0.2)

    doc.font('Helvetica').fontSize(9)
    const rows = [
      ['Q1 (15.02.)', vq.q1],
      ['Q2 (15.05.)', vq.q2],
      ['Q3 (15.08.)', vq.q3],
      ['Q4 (15.11.)', vq.q4],
      ['Summe (Kz 11)', vq.total],
    ]
    for (const [label, val] of rows) {
      const y = doc.y
      const isTotal = String(label).startsWith('Summe')
      doc.font(isTotal ? 'Helvetica-Bold' : 'Helvetica')
      doc.text(String(label), colLabel, y)
      doc.text(this.fmtEur(val as number), colValue, y, {
        width: 200,
        align: 'right',
      })
      doc.moveDown(0.15)
    }
  }

  private renderLinesTable(
    doc: PDFKit.PDFDocument,
    lines: GewstLine[],
  ): void {
    const tableTop = doc.y
    const colKz = 40
    const colLabel = 75
    const colValue = 470

    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Kz', colKz, tableTop)
    doc.text('Bezeichnung', colLabel, tableTop)
    doc.text('Betrag / %', colValue, tableTop, { width: 85, align: 'right' })
    doc.moveDown(0.3)
    doc
      .moveTo(colKz, doc.y)
      .lineTo(555, doc.y)
      .strokeColor('#333')
      .lineWidth(0.5)
      .stroke()
    doc.moveDown(0.2)

    doc.font('Helvetica').fontSize(9)
    for (const l of lines) {
      const y = doc.y
      doc.text(l.kennziffer, colKz, y)
      doc.text(l.label, colLabel, y, { width: 390 })
      const val =
        l.amount !== undefined
          ? this.fmtEur(l.amount)
          : l.percent !== undefined
          ? `${l.percent.toFixed(0)} %`
          : '—'
      doc.text(val, colValue, y, { width: 85, align: 'right' })
      doc.moveDown(0.15)
      if (l.note) {
        doc
          .fontSize(7)
          .fillColor('#666')
          .text(`Hinweis: ${l.note}`, colLabel, doc.y, { width: 380 })
          .fillColor('#000')
          .fontSize(9)
        doc.moveDown(0.15)
      }
    }
  }

  private fmtEur(n: number): string {
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }
}
