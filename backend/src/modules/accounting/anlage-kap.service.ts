import { flowFromLeft } from '../../common/pdf-flow'
import { Injectable, BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Anlage KAP — Einkünfte aus Kapitalvermögen (§ 20 EStG): a preview from the
 * credits of the imported bank accounts whose purpose names interest or a
 * dividend.
 *
 * Tier 670 — read against the statute (gesetze-im-internet.de, 12.10.2026):
 *
 *   § 20 Abs. 8   Capital income that belongs to a business is business
 *                 income, not capital income: it goes into the profit, and
 *                 the Sparer-Pauschbetrag is not for it (§ 32d Abs. 1: the
 *                 25 % are for income "die nicht unter § 20 Absatz 8
 *                 fallen"). The accounts imported here are mostly the
 *                 business's — the form says so, and leaves out what is
 *                 booked or matched to an invoice: that is in the books.
 *   § 20 Abs. 9   Sparer-Pauschbetrag 1 000 € (2 000 € for spouses assessed
 *                 together) from 2023, 801 € / 1 602 € before; never more
 *                 than the capital income. Before: 1 000 € for every year,
 *                 no way to say "together", and the full amount shown
 *                 against 300 € of income.
 *   What a bank credits is what is left after the tax it withheld; the
 *   gross income and the tax are on the bank's Steuerbescheinigung, from
 *   which the real Anlage KAP is filled in. The 25 % + Soli shown here are
 *   what would be due if nothing was withheld — the form says that too.
 *
 * Before, „Zins“ anywhere in the purpose made a credit interest income: a
 * customer's payment „Rechnung 12 inkl. Verzugszinsen“ of 1 190 € counted,
 * as would a rent paid as „Mietzins“.
 *
 * The Kennziffern 7100-7900 are this preview's own numbers, not the lines
 * of the official form.
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
    /** credits naming interest or a dividend that are booked or matched to an invoice — business income, left out */
    leftOutBooked: number
  }
  /** § 20 Abs. 9: the allowance of the year, and whether the spouses' joint one */
  sparerPauschbetrag: { voll: number; angesetzt: number; zusammenveranlagung: boolean }
  generatedAt: string
  disclaimer: string
}

// Tier 98: Anlage KAP Einnahmen Kennziffern 7100-7190.
// v1 heuristic: regex on BankTransaction.purpose
// to tentatively identify Zinserträge and
// Dividendenerträge. The user can override
// in their ELSTER submission.
// „Zinsen“, „Habenzinsen“, „Zinsgutschrift“ … as words of their own — not the
// „zins“ inside Verzugszinsen, Mietzins, Erbbauzins, Sollzinsen
const ZINS = /(?<![A-Za-zÄÖÜäöüß])(?:Haben|Guthaben|Spar|Gutschrifts)?zins(?:en|gutschrift|ertrag|erträge|abschluss)?(?![A-Za-zÄÖÜäöüß])/i
const DIVIDENDE = /(?<![A-Za-zÄÖÜäöüß])(?:Dividenden?(?:zahlung|gutschrift)?|Ausschüttung(?:en)?|Kupon(?:zahlung|gutschrift)?)(?![A-Za-zÄÖÜäöüß])/i
const isGerman = (tx: any): boolean => !tx.counterpartyIban || String(tx.counterpartyIban).toUpperCase().startsWith('DE')

/** § 20 Abs. 9 EStG: 1 000 € from 2023, 801 € before; twice for spouses assessed together. */
export const sparerPauschbetragFor = (year: number, together = false): number =>
  (year >= 2023 ? 1000 : 801) * (together ? 2 : 1)

const EINNAHMEN_LINES: Array<{
  kz: string
  label: string
  matcher: (tx: any) => boolean
  placeholder?: string
}> = [
  {
    kz: '7100',
    label: 'Inländische Zinserträge (Tagesgeld, Festgeld, Sparbuch)',
    matcher: (tx) => Number(tx.amount) > 0 && ZINS.test(tx.purpose || '') && isGerman(tx),
  },
  {
    kz: '7110',
    label: 'Ausländische Zinserträge',
    matcher: (tx) => Number(tx.amount) > 0 && ZINS.test(tx.purpose || '') && !isGerman(tx),
  },
  {
    kz: '7120',
    label: 'Inländische Dividendenerträge / Ausschüttungen',
    matcher: (tx) => Number(tx.amount) > 0 && DIVIDENDE.test(tx.purpose || '') && isGerman(tx),
  },
  {
    kz: '7130',
    label: 'Ausländische Dividendenerträge',
    matcher: (tx) => Number(tx.amount) > 0 && DIVIDENDE.test(tx.purpose || '') && !isGerman(tx),
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
    matcher: (_tx) => {
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
    label: 'Sparer-Pauschbetrag', // the amounts of the year are added in compute()
    amount: 'auto',
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
        voucherId: true,
        matches: { where: { status: { not: 'rejected' } }, select: { id: true } },
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

    // § 20 Abs. 8: a credit that is booked, or matched to an invoice, is in
    // the business's books — business income, not capital income
    let leftOutBooked = 0
    for (const tx of bankTransactions) {
      for (const line of EINNAHMEN_LINES) {
        if (line.matcher(tx)) {
          if (tx.voucherId || tx.matches.length > 0) leftOutBooked++
          else transactionsByKz[line.kz].push(tx)
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

    // § 20 Abs. 9: the allowance of the year — and never more than the income
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    const settings = (company?.settings as any) || {}
    const zusammenveranlagung = settings.anlageKAPZusammenveranlagung === true
    const voll = sparerPauschbetragFor(year, zusammenveranlagung)
    const sparerPauschbetrag = Math.min(voll, Math.max(0, round2(einnahmenTotal)))
    const eur = (n: number): string => new Intl.NumberFormat('de-DE').format(n)

    const abzuege: AnlageKAPLine[] = []
    let abzuegeTotal = 0
    for (const line of ABZUEGE_LINES) {
      const amount =
        line.amount === 'auto' ? sparerPauschbetrag : line.amount
      abzuege.push({
        kennziffer: line.kz,
        label:
          line.amount === 'auto'
            ? `Sparer-Pauschbetrag (§ 20 Abs. 9 EStG): ${eur(sparerPauschbetragFor(year))} EUR, bei Zusammenveranlagung ${eur(sparerPauschbetragFor(year, true))} EUR — höchstens die Kapitalerträge`
            : line.label,
        amount: round2(amount),
        source: line.amount === 'auto' ? 'computed' : 'placeholder',
        note:
          line.amount === 'auto'
            ? zusammenveranlagung
              ? 'Angesetzt ist der gemeinsame Sparer-Pauschbetrag (Zusammenveranlagung).'
              : undefined
            : line.note,
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
        leftOutBooked,
      },
      sparerPauschbetrag: { voll, angesetzt: sparerPauschbetrag, zusammenveranlagung },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau zeigt Gutschriften der hier importierten Konten, deren Verwendungszweck Zinsen oder ' +
        'Dividenden nennt und die weder verbucht noch einer Rechnung zugeordnet sind. ' +
        'Erträge eines betrieblichen Kontos sind keine Einkünfte aus Kapitalvermögen, sondern Betriebseinnahmen ' +
        '(§ 20 Abs. 8 EStG): sie gehören in die Gewinnermittlung, der Sparer-Pauschbetrag gilt für sie nicht. ' +
        'In die Anlage KAP gehören nur Erträge privater Konten. ' +
        'Eine Gutschrift ist der Betrag nach Abzug der von der Bank einbehaltenen Kapitalertragsteuer; der ' +
        'Bruttoertrag und die einbehaltene Steuer stehen in der Steuerbescheinigung der Bank, nach der die ' +
        'Anlage KAP ausgefüllt wird. ' +
        'Nicht erfasst und als Platzhalter gezeigt: Fondserträge, Veräußerungsgewinne, Termingeschäfte, ' +
        'ausländische Quellensteuer, Kirchensteuer, Verluste und der Verlustvortrag nach § 20 Abs. 6 EStG — ' +
        'der Steuerberater ergänzt sie aus den Bescheinigungen der Banken.',
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

    const doc = flowFromLeft(new PDFDocument({ size: 'A4', margin: 40 }))
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
        `${data.counts.matchedZinsTransactions} Zins- und ${data.counts.matchedDividendeTransactions} Dividendengutschriften unter ${data.counts.bankTransactions} Bankbuchungen` +
          (data.counts.leftOutBooked > 0
            ? `; ${data.counts.leftOutBooked} weitere sind verbucht oder einer Rechnung zugeordnet — Betriebseinnahmen (§ 20 Abs. 8 EStG), hier nicht angesetzt.`
            : '.'),
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
      .text('Abgeltungsteuer, wenn die Bank nichts einbehalten hat', { align: 'left' })
      .moveDown(0.3)
    doc.fontSize(10).font('Helvetica')
    doc.text(
      `Abgeltungsteuer (25 %, § 32d Abs. 1 EStG): ${data.abgeltungssteuer.expectedSteuer.toFixed(2)} EUR`,
      40,
      doc.y,
      { width: 515 },
    )
    doc.text(
      `Solidaritätszuschlag (5,5 % der Steuer): ${data.abgeltungssteuer.expectedSoli.toFixed(2)} EUR`,
      40,
      doc.y,
      { width: 515 },
    )
    doc
      .fontSize(8)
      .fillColor('#666')
      .text(
        'Gerechnet auf die Gutschriften abzüglich Sparer-Pauschbetrag. Hat die Bank Kapitalertragsteuer einbehalten, ist die Gutschrift schon der Betrag danach und nichts mehr zu zahlen; maßgeblich ist die Steuerbescheinigung der Bank.',
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
