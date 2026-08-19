import { Injectable, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 98: Anlage KAP — Einkünfte aus
 * Kapitalvermögen (§ 20 EStG).
 *
 * The German tax filing for investment
 * income: a year-end attachment to the
 * Einkommensteuererklärung. Pairs with Anlage
 * S (freelancer) and Anlage V (Vermietung).
 *
 * Three key concepts:
 *   1. **Abgeltungssteuer** — 25% flat tax on
 *      most Kapitalerträge (Zinsen, Dividenden,
 *      Veräußerungsgewinne). Already deducted
 *      at source by the bank / depot. The Anlage
 *      KAP declares the gross + the tax already
 *      paid so the Finanzamt can apply the
 *      Sparer-Pauschbetrag (801 EUR / 1602 EUR
 *      Zusammenveranlagung).
 *   2. **Sparer-Pauschbetrag** — 1000 EUR
 *      (single) / 2000 EUR (Zusammenveranlagung)
 *      tax-free allowance. Only the difference
 *      is taxable.
 *   3. **Kirchensteuer + Solidaritätszuschlag**
 *      — additional 5.5% Soli on the Abgeltungs-
 *      steuer, plus 8-9% KiSt depending on
 *      Bundesland.
 *
 * v1 heuristic: bank transactions with
 * "Zins" / "Zinsen" / "Dividende" / "Ausschüttung"
 * in the purpose field are tentatively classified
 * as Kapitalerträge. The opt-in flag
 * `Company.settings.anlageKAP === true` gates
 * whether the report is generated (the user
 * enables Anlage KAP on a per-company basis
 * when the company has investment income).
 *
 * Output: per-Kennziffer lines + Sparer-Pausch-
 * betrag + taxable base + summary. Same VORSCHAU
 * (preview) caveat as Anlage S / Anlage V — the
 * disclaimer surfaces in the response + the PDF
 * footer.
 *
 * The Kennziffern 7100-7900 are an internal
 * namespace (not BMF's actual Zeile numbers in
 * the printable Anlage KAP form). The Berater
 * maps them to the BMF Zeile positions when
 * transcribing the VORSCHAU into the actual
 * ElsterForm / PDF form.
 */
export interface AnlageKAPLine {
  kennziffer: string
  label: string
  amount: number
  source: 'computed' | 'placeholder'
  note?: string
}

export interface AnlageKAPResult {
  year: number
  companyId: string
  einnahmen: AnlageKAPLine[]
  abzuege: AnlageKAPLine[]
  totals: {
    einnahmenTotal: number
    abzuegeTotal: number
    zuVersteuern: number // einnahmen - abzuege (clamped to >= 0)
  }
  // The 25% Abgeltungssteuer is normally already
  // deducted at source by the depot / bank. We
  // surface it for the Berater to verify the
  // bank-reported figure matches the Anlage KAP
  // declaration.
  abgeltungssteuer: {
    rate: number // 0.25
    soliRate: number // 0.055
    expectedSteuer: number // 25% of zuVersteuern
    expectedSoli: number // 5.5% of expectedSteuer
  }
  counts: {
    bankTransactions: number
    matchedZinsTransactions: number
    matchedDividendeTransactions: number
  }
  generatedAt: string
  disclaimer: string
}

// Tier 98: Anlage KAP Einnahmen Kennziffern 7100-7190.
// v1 heuristic: regex on BankTransaction.purpose
// to tentatively identify Zinserträge and
// Dividendenerträge. The user can override
// in their ELSTER submission.
const EINNAHMEN_LINES: Array<{
  kz: string
  label: string
  matcher: (tx: any) => boolean
  placeholder?: string
}> = [
  {
    kz: '7100',
    label: 'Inländische Zinserträge (Tagesgeld, Festgeld, Sparbuch)',
    matcher: (tx) =>
      Number(tx.amount) > 0 &&
      /Zins(en)?|Habenzins|Gutschriftszins/i.test(tx.purpose || '') &&
      // Inländisch if the counterparty IBAN starts with DE
      (!tx.counterpartyIban || tx.counterpartyIban.startsWith('DE')),
  },
  {
    kz: '7110',
    label: 'Ausländische Zinserträge',
    matcher: (tx) =>
      Number(tx.amount) > 0 &&
      /Zins(en)?|Habenzins|Gutschriftszins/i.test(tx.purpose || '') &&
      tx.counterpartyIban &&
      !tx.counterpartyIban.startsWith('DE'),
  },
  {
    kz: '7120',
    label: 'Inländische Dividendenerträge / Ausschüttungen',
    matcher: (tx) =>
      Number(tx.amount) > 0 &&
      /Dividende|Ausschüttung|Kupongewinn/i.test(tx.purpose || '') &&
      (!tx.counterpartyIban || tx.counterpartyIban.startsWith('DE')),
  },
  {
    kz: '7130',
    label: 'Ausländische Dividendenerträge',
    matcher: (tx) =>
      Number(tx.amount) > 0 &&
      /Dividende|Ausschüttung/i.test(tx.purpose || '') &&
      tx.counterpartyIban &&
      !tx.counterpartyIban.startsWith('DE'),
  },
  {
    kz: '7140',
    label: 'Erträge aus Investmentfonds (Thesaurierung / Ausschüttung)',
    matcher: () => false, // no fund-specific signal in bank purpose
    placeholder:
      'Investmentfonds-Erträge — in de-invoice nicht erfasst (kein Fondstracking). Berater füllt manuell.',
  },
  {
    kz: '7150',
    label: 'Veräußerungsgewinne Aktien (Haltedauer beliebig)',
    matcher: () => false, // no buy/sell pair detection in v1
    placeholder:
      'Aktien-Veräußerungsgewinne — in de-invoice nicht erfasst (kein Brokerage-Tracking). Berater füllt manuell.',
  },
  {
    kz: '7160',
    label: 'Veräußerungsgewinne Fonds / ETFs',
    matcher: () => false,
    placeholder:
      'Fonds-/ETF-Veräußerungsgewinne — in de-invoice nicht erfasst. Berater füllt manuell.',
  },
  {
    kz: '7170',
    label: 'Termingeschäftsgewinne (Optionen, Futures, Zertifikate)',
    matcher: () => false,
    placeholder:
      'Termingeschäftsgewinne — in de-invoice nicht erfasst. Berater füllt manuell.',
  },
  {
    kz: '7180',
    label: 'Stillhalterprämien (Optionen verkauft)',
    matcher: () => false,
    placeholder:
      'Stillhalterprämien — in de-invoice nicht erfasst. Berater füllt manuell.',
  },
  {
    kz: '7190',
    label: 'Sonstige Kapitalerträge (Crowdinvesting, Genussrechte, etc.)',
    matcher: (tx) => {
      // Fallback for any positive bank transaction that
      // doesn't match the other matchers — typically
      // returns 0 because all positive Zinserträge
      // already match 7100/7110/7120/7130.
      return false
    },
    placeholder:
      'Sonstige Kapitalerträge — in de-invoice nicht erfasst. Berater füllt manuell.',
  },
]

// Tier 98: Anlage KAP Abzüge Kennziffern 7200-7690.
// Sparer-Pauschbetrag (7300) is the big one —
// 1000 EUR / 2000 EUR Zusammenveranlagung. The
// other lines are mostly tax-side adjustments
// (anzurechnende ausländische Steuern, etc.)
const ABZUEGE_LINES: Array<{
  kz: string
  label: string
  amount: number | 'auto' // 'auto' = computed from settings
  note?: string
}> = [
  {
    kz: '7200',
    label: 'Verluste aus Kapitalvermögen (allgemeine Verlustverrechnung)',
    amount: 0, // placeholder — no loss tracking in v1
    note: 'Allgemeine Verlustverrechnung — in de-invoice nicht erfasst. Berater füllt manuell.',
  },
  {
    kz: '7300',
    label: 'Sparer-Pauschbetrag (1.000 EUR / 2.000 EUR Zusammenveranlagung)',
    amount: 'auto', // 1000 default; user can adjust in settings (v2)
  },
  {
    kz: '7400',
    label: 'Anzurechnende ausländische Steuern (§ 34c EStG)',
    amount: 0,
    note: 'Ausländische Quellensteuer — in de-invoice nicht erfasst. Berater füllt manuell.',
  },
  {
    kz: '7500',
    label: 'Anzurechnende Zinsabschlagsteuer (historisch, vor 2009)',
    amount: 0,
    note: 'Zinsabschlagsteuer — historisch (vor 2009 abgelöst durch Abgeltungssteuer). In de-invoice nicht relevant.',
  },
  {
    kz: '7600',
    label: 'Nicht ausgeglichene Verluste (Verlustvortrag § 20 Abs. 6 EStG)',
    amount: 0,
    note: 'Verlustvortrag — in de-invoice nicht erfasst. Berater füllt manuell.',
  },
  {
    kz: '7700',
    label: 'Kirchensteuer auf Abgeltungssteuer (8-9% je Bundesland)',
    amount: 0,
    note: 'Kirchensteuer — vom Bankinstitut automatisch einbehalten, in de-invoice nicht erfasst. Berater prüft.',
  },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class AnlageKAPService {
  constructor(private prisma: PrismaService) {}

  /**
   * Compute the Anlage KAP for the year. Returns
   * the report JSON. The controller wraps this
   * in the year-defaults + auth handling.
   *
   * v1: tentatively identify Kapitalerträge
   * from BankTransaction.purpose field via
   * regex matchers. The user can override
   * categorizations in their ELSTER submission.
   */
  async compute(companyId: string, year: number): Promise<AnlageKAPResult> {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)

    // Pull all bank transactions in the year.
    // We only look at POSITIVE amounts (incoming
    // money). Negative amounts are typically
    // outgoing payments (not Kapitalerträge).
    // We don't filter by reconciliation status —
    // a not-yet-reconciled transaction can still
    // be a Kapitalertrag.
    const bankTransactions = await this.prisma.bankTransaction.findMany({
      where: {
        companyId,
        valueDate: { gte: yearStart, lte: yearEnd },
      },
      select: {
        amount: true,
        purpose: true,
        counterpartyIban: true,
      },
    })

    // Bucket per Kennziffer via matchers.
    // A transaction can only land in ONE
    // einnahmen bucket (first match wins);
    // once it's classified as Zinsertrag in
    // 7100, it doesn't also count as
    // Dividendenertrag in 7120.
    const einnahmen: AnlageKAPLine[] = []
    const transactionsByKz: Record<string, any[]> = {}
    for (const line of EINNAHMEN_LINES) {
      transactionsByKz[line.kz] = []
    }

    for (const tx of bankTransactions) {
      for (const line of EINNAHMEN_LINES) {
        if (line.matcher(tx)) {
          transactionsByKz[line.kz].push(tx)
          break // first match wins
        }
      }
    }

    let einnahmenTotal = 0
    for (const line of EINNAHMEN_LINES) {
      const txs = transactionsByKz[line.kz]
      const amount = round2(
        txs.reduce(
          (s, tx) => s.plus(tx.amount ?? new Prisma.Decimal(0)),
          new Prisma.Decimal(0),
        ).toNumber(),
      )
      const isPlaceholder = !line.matcher || txs.length === 0
      einnahmen.push({
        kennziffer: line.kz,
        label: line.label,
        amount: isPlaceholder && line.placeholder ? 0 : amount,
        source: isPlaceholder && line.placeholder ? 'placeholder' : 'computed',
        note: line.placeholder,
      })
      einnahmenTotal += amount
    }

    // Count matched transactions for the diagnostics.
    const matchedZins = (transactionsByKz['7100'] || [])
      .concat(transactionsByKz['7110'] || [])
      .length
    const matchedDividende = (transactionsByKz['7120'] || [])
      .concat(transactionsByKz['7130'] || [])
      .length

    // Abzüge: 7300 is 'auto' (Sparer-Pauschbetrag,
    // default 1000 EUR — the user adjusts via
    // Company.settings.sparerPauschbetrag if
    // they want Zusammenveranlagung's 2000).
    // v1: hard-coded 1000; v2: read from
    // Company.settings.sparerPauschbetrag.
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    const settings = (company?.settings as any) || {}
    const sparerPauschbetrag =
      typeof settings.sparerPauschbetrag === 'number'
        ? settings.sparerPauschbetrag
        : 1000

    const abzuege: AnlageKAPLine[] = []
    let abzuegeTotal = 0
    for (const line of ABZUEGE_LINES) {
      const amount =
        line.amount === 'auto' ? sparerPauschbetrag : line.amount
      abzuege.push({
        kennziffer: line.kz,
        label: line.label,
        amount: round2(amount),
        source: line.amount === 'auto' ? 'computed' : 'placeholder',
        note: line.note,
      })
      abzuegeTotal += amount
    }

    // Zu versteuern = Einnahmen - Abzüge,
    // clamped to >= 0 (Verlustvortrag handles
    // negative cases per § 20 Abs. 6 EStG).
    const zuVersteuern = round2(Math.max(0, einnahmenTotal - abzuegeTotal))

    // 25% Abgeltungssteuer + 5.5% Soli on the
    // Abgeltungssteuer. The bank usually
    // already deducted this — the Berater
    // verifies the bank-reported figure
    // matches the Anlage KAP declaration.
    const expectedSteuer = round2(zuVersteuern * 0.25)
    const expectedSoli = round2(expectedSteuer * 0.055)

    return {
      year,
      companyId,
      einnahmen,
      abzuege,
      totals: {
        einnahmenTotal: round2(einnahmenTotal),
        abzuegeTotal: round2(abzuegeTotal),
        zuVersteuern,
      },
      abgeltungssteuer: {
        rate: 0.25,
        soliRate: 0.055,
        expectedSteuer,
        expectedSoli,
      },
      counts: {
        bankTransactions: bankTransactions.length,
        matchedZinsTransactions: matchedZins,
        matchedDividendeTransactions: matchedDividende,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Anlage KAP ist eine VORSCHAU basierend auf den in de-invoice v1 verfügbaren Daten. ' +
        'Die Klassifizierung der Kapitalerträge erfolgt anhand einer Heuristik auf den Verwendungszweck-Feldern ' +
        'importierter Banktransaktionen. Anlage KAP-spezifische Themen (Investmentfonds-Thesaurierung, ' +
        'Veräußerungsgewinne, Termingeschäfte, ausländische Quellensteuer, Kirchensteuer auf ' +
        'Abgeltungssteuer, Verlustvortrag nach § 20 Abs. 6 EStG) sind als Platzhalter markiert. ' +
        'Der Steuerberater prüft die Klassifizierung im ELSTER-Mein-ELSTER-Client und ergänzt die ' +
        'fehlenden Positionen aus den Jahresdepotauszügen.',
    }
  }

  /**
   * Render the Anlage KAP as a human-readable
   * PDF for the Berater to review before
   * transcription into the BMF Anlage KAP form.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-KAP-VORSCHAU-${year}.pdf"`,
    )

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text('Anlage KAP — VORSCHAU', { align: 'left' })
      .fontSize(10)
      .font('Helvetica')
      .text(`Geschäftsjahr ${year}`)
      .moveDown(0.5)
      .text(
        `Generiert: ${new Date(data.generatedAt).toLocaleString('de-DE')}`,
      )
      .moveDown()

    // Counts summary
    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .text(
        `${data.counts.matchedZinsTransactions} Zins- + ${data.counts.matchedDividendeTransactions} Dividendentransaktionen aus ${data.counts.bankTransactions} Bankbuchungen erkannt.`,
      )
      .moveDown(0.5)

    // Einnahmen table
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .text('Einnahmen aus Kapitalvermögen', { align: 'left' })
      .moveDown(0.3)
    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Kz.', 40, doc.y, { continued: true })
    doc.text('Bezeichnung', 80, doc.y, { continued: true })
    doc.text('Betrag (EUR)', 420, doc.y, { align: 'right' })
    doc.moveDown(0.3)
    doc.font('Helvetica').fontSize(9)
    doc
      .moveTo(40, doc.y)
      .lineTo(555, doc.y)
      .stroke()
      .moveDown(0.3)

    for (const line of data.einnahmen) {
      const yStart = doc.y
      doc.text(line.kennziffer, 40, yStart, { width: 35 })
      doc.text(line.label, 80, yStart, { width: 320 })
      doc.text(line.amount.toFixed(2), 420, yStart, { width: 130, align: 'right' })
      doc.moveDown(0.2)
      if (line.note) {
        doc
          .fontSize(7)
          .fillColor('#666')
          .text(`Hinweis: ${line.note}`, 80, doc.y, { width: 470 })
          .fillColor('black')
          .fontSize(9)
        doc.moveDown(0.2)
      }
    }

    // Einnahmen total
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text(
      `Summe Einnahmen: ${data.totals.einnahmenTotal.toFixed(2)} EUR`,
      40,
      doc.y,
      { width: 515, align: 'right' },
    )
    doc.font('Helvetica').fontSize(9)
    doc.moveDown(1)

    // Abzüge table
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .text('Abzüge / Pauschbeträge', { align: 'left' })
      .moveDown(0.3)
    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Kz.', 40, doc.y, { continued: true })
    doc.text('Bezeichnung', 80, doc.y, { continued: true })
    doc.text('Betrag (EUR)', 420, doc.y, { align: 'right' })
    doc.moveDown(0.3)
    doc.font('Helvetica').fontSize(9)
    doc
      .moveTo(40, doc.y)
      .lineTo(555, doc.y)
      .stroke()
      .moveDown(0.3)

    for (const line of data.abzuege) {
      const yStart = doc.y
      doc.text(line.kennziffer, 40, yStart, { width: 35 })
      doc.text(line.label, 80, yStart, { width: 320 })
      doc.text(line.amount.toFixed(2), 420, yStart, { width: 130, align: 'right' })
      doc.moveDown(0.2)
      if (line.note) {
        doc
          .fontSize(7)
          .fillColor('#666')
          .text(`Hinweis: ${line.note}`, 80, doc.y, { width: 470 })
          .fillColor('black')
          .fontSize(9)
        doc.moveDown(0.2)
      }
    }

    // Abzüge total
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text(
      `Summe Abzüge: ${data.totals.abzuegeTotal.toFixed(2)} EUR`,
      40,
      doc.y,
      { width: 515, align: 'right' },
    )
    doc.font('Helvetica').fontSize(9)
    doc.moveDown(1)

    // Zu versteuern
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .text('Zu versteuernde Kapitalerträge', { align: 'left' })
      .moveDown(0.3)
    doc
      .fontSize(14)
      .font('Helvetica-Bold')
      .fillColor(data.totals.zuVersteuern > 0 ? '#047857' : '#666')
      .text(`${data.totals.zuVersteuern.toFixed(2)} EUR`, { align: 'right' })
      .fillColor('black')
      .moveDown(0.5)
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#666')
      .text(
        '= Summe Einnahmen − Summe Abzüge. Bei negativem Saldo greift § 20 Abs. 6 EStG (Verlustvortrag).',
        40,
        doc.y,
        { width: 515 },
      )
      .fillColor('black')
      .moveDown(1)

    // Abgeltungssteuer info
    doc
      .fontSize(13)
      .font('Helvetica-Bold')
      .text('Abgeltungssteuer (zur Information)', { align: 'left' })
      .moveDown(0.3)
    doc.fontSize(10).font('Helvetica')
    doc.text(
      `Erwartete Abgeltungssteuer (25%): ${data.abgeltungssteuer.expectedSteuer.toFixed(2)} EUR`,
      40,
      doc.y,
      { width: 515 },
    )
    doc.text(
      `Erwarteter Solidaritätszuschlag (5.5%): ${data.abgeltungssteuer.expectedSoli.toFixed(2)} EUR`,
      40,
      doc.y,
      { width: 515 },
    )
    doc
      .fontSize(8)
      .fillColor('#666')
      .text(
        'Diese Beträge werden in der Regel direkt von der Bank / dem Depot einbehalten und im Jahresdepotauszug ausgewiesen. Der Steuerberater prüft die Übereinstimmung mit dem Anlage KAP.',
        40,
        doc.y,
        { width: 515 },
      )
      .fillColor('black')
      .moveDown(1)

    // Disclaimer
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#666')
      .text(data.disclaimer, 40, doc.y, { width: 515, align: 'justify' })
      .fillColor('black')

    doc.end()
  }
}
