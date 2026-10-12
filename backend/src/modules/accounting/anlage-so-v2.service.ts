import { freigrenzeFor, looksLikeCrypto, rowLine, splitRows, vgSummary, VgKind, VG_KINDS } from './anlage-so-rules'
import { flowFromLeft } from '../../common/pdf-flow'
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 113 v2: Anlage SO — extends v1 (private
 * Veräußerungsgeschäfte + wiederkehrende Bezüge) with:
 *
 *   1. Broker PDF/CSV auto-import
 *      — `parseCsv()` validates a 6-column CSV
 *        (type, description, acquisitionDate,
 *        acquisitionCost, saleDate, salePrice) with
 *        German date format dd.mm.yyyy + German
 *        decimal with comma. Detects `type` from
 *        the description when the column is empty
 *        (BTC/ETH/... = "krypto", AAPL/MSFT/... =
 *        "wertpapier", else "sonstige"). Returns
 *        either a preview (previewOnly=true) or
 *        persists the parsed rows into
 *        Company.settings.anlageSO[year].transactions.
 *
 *   2. The year's result by the rules of § 23 EStG
 *      (anlage-so-rules.ts, `vgSummary`): each sale by
 *      the period of its kind (land ten years, other
 *      assets one; securities bought since 2009 are
 *      capital income and not counted), the year's
 *      losses set off against its gains, less the loss
 *      carried forward from the year before:
 *
 *      inFristGain / inFristLoss  of the sales within
 *                                 their period
 *      priorYearLoss   = settings.anlageSOLossCarryforward[year-1] || 0
 *      totalTaxableGain = max(0, inFristGain - inFristLoss - priorYearLoss)
 *      carryforward     = max(0, inFristLoss + priorYearLoss - inFristGain)
 *      vgTotal = 0 while totalTaxableGain is below the
 *                Freigrenze of the year (1 000 EUR from
 *                2024, 600 EUR before), else all of it
 *
 *   3. Auto-import from bank-transaction Expense
 *      rows. Reuses the `Expense.category` field
 *      (values "crypto" or "brokerage") and converts
 *      each row into a VgTransaction. Idempotent:
 *      `metadata.importedFromExpenseId` on each
 *      transaction tracks the source. Re-import
 *      skips already-imported (skippedCount tracks
 *      these).
 *
 * The v2 service coexists with v1. v1's compute() /
 * renderPdf() are kept for backward compat. The v2
 * controller (anlage-so-v2.controller.ts) exposes
 * the 3 new endpoints, plus a read of the current
 * loss carryforward.
 *
 * v2 data model: Company.settings.anlageSO[year] = {
 *   transactions: VgTransaction[]   (v1 shape)
 *   wiederkehrendeBezuege: number   (v1)
 *   werbungskosten: number          (v1)
 * }
 * Company.settings.anlageSOLossCarryforward[year] = number
 *   // v2: loss-vortrag from year N → year N+1.
 *   // set when the year's computed carryforward > 0
 *   // (the service does this in compute() before
 *   // returning, so the next GET sees the stored
 *   // value).
 *
 * Transactions keep their existing shape:
 *   { type, description, acquisitionDate,
 *     acquisitionCost, saleDate, salePrice,
 *     metadata? }
 * The optional `metadata` field is v2-only (used for
 * the `importedFromExpenseId` stamp from the
 * /import-from-expenses flow). Existing v1 transactions
 * that don't carry a `metadata` are unchanged.
 */

export interface VgTransaction {
  type: VgKind // Tier 664: krypto | sonstige | grundstueck | wertpapier
  description: string
  acquisitionDate: string // ISO date YYYY-MM-DD
  acquisitionCost: number
  saleDate: string
  salePrice: number
  metadata?: { importedFromExpenseId?: string; importedAt?: string }
  /** 2: the kind is the one chosen (anlage-so-rules.ts) */
  v?: number
}

export interface CsvPreviewRow {
  rowIndex: number
  raw: Record<string, string>
  transaction: VgTransaction
  warnings: string[]
  ok: boolean
}

export interface CsvImportResult {
  importedCount: number
  skippedCount: number
  transactions: VgTransaction[]
}

// Tier 656: the limit depends on the year — anlage-so-rules.ts

// Heuristics for type auto-detection when the CSV
// `type` column is empty. Crypto ticker symbols are
// short (3-5 chars, all-uppercase like BTC, ETH, SOL)
// — they map to "sonstige" since crypto falls under
// § 23 Abs. 1 Nr. 2 EStG (1-year Frist; the BMF
// treats crypto as sonstige WG, but applies the
// 1-year Wertpapier-Spekulationsfrist by analogy).
// For our v2 purposes "sonstige" with the wertpapier
// frist would require a 3rd type. To keep the data
// model unchanged, we map crypto to "wertpapier" so
// the existing 1-year Frist check applies; the v2
// SPEC clarifies this in the disclaimer. Listed
// securities (AAPL/MSFT/TSLA) also map to
// "wertpapier". Everything else → "sonstige"
// (10-year Frist).
const CRYPTO_TICKERS = new Set([
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOT', 'AVAX', 'MATIC', 'LINK',
  'LTC', 'BCH', 'XLM', 'TRX', 'DOGE', 'SHIB', 'UNI', 'ATOM', 'ALGO',
  'XTZ', 'EOS', 'XMR', 'DASH', 'ETC', 'NEO', 'ZEC',
])
const SECURITY_TICKERS = new Set([
  'AAPL', 'MSFT', 'TSLA', 'AMZN', 'GOOG', 'GOOGL', 'META', 'NVDA',
  'AMD', 'INTC', 'IBM', 'ORCL', 'CSCO', 'ADBE', 'CRM', 'PYPL',
  'NFLX', 'DIS', 'BA', 'JPM', 'V', 'MA', 'WMT', 'KO', 'PEP',
  'MCD', 'NKE', 'SBUX', 'T', 'VZ', 'XOM', 'CVX', 'BP', 'SHEL',
  'VOW3', 'BMW', 'DTE', 'ALV', 'SAP', 'SIE', 'BAS', 'BAYN',
  'ALB', 'LHA', 'TKA', 'RWE', 'EOAN', 'MUV2', 'DBK', 'CBK',
  'ADS', 'PUM', 'HEN3', 'BEI', 'CON', '1COV', 'ZAL', 'IFX',
  'FME', 'FRE', 'HEI', 'MTX', 'PAH3', 'QIA', 'SRT3', 'SY1',
])

// Tier 665: the categories of an expense that is a purchase of crypto or of
// securities. The category is free text on the expense; the page names
// „Krypto“ and „Wertpapier“ — only the exact lower-case English "crypto" and
// "brokerage" were found before.
const CRYPTO_CATEGORY = ['krypto', 'crypto']
const SECURITY_CATEGORY = ['wertpapier', 'brokerage', 'depot', 'aktie']
const isCryptoCategory = (category: string | null): boolean =>
  CRYPTO_CATEGORY.some((w) => String(category || '').toLowerCase().startsWith(w))

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Parse a German-style date string `dd.mm.yyyy` (the
 * format every German broker PDF / CSV exports use,
 * because Excel writes `01.03.2024` not `2024-03-01`).
 * Also accepts the ISO form `yyyy-mm-dd` for paste
 * convenience. Returns `null` on bad input.
 */
function parseDeDate(s: string): string | null {
  const trimmed = (s || '').trim()
  if (!trimmed) return null
  // ISO yyyy-mm-dd
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    if (y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${m[1]}-${m[2]}-${m[3]}`
    }
    return null
  }
  // dd.mm.yyyy
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed)
  if (m) {
    const d = Number(m[1])
    const mo = Number(m[2])
    const y = Number(m[3])
    if (y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const dd = String(d).padStart(2, '0')
      const mm = String(mo).padStart(2, '0')
      return `${y}-${mm}-${dd}`
    }
    return null
  }
  return null
}

/**
 * Parse a German-style decimal string. German
 * numbers use `,` as the decimal separator and
 * `.` as the thousands separator (or no separator
 * at all). Examples: "1500,00", "1.500,00", "12,5",
 * "0,99". Also accepts plain "1500.00" for paste
 * convenience. Returns `null` on bad input.
 */
function parseDeDecimal(s: string): number | null {
  const trimmed = (s || '').trim()
  if (!trimmed) return null
  // Replace "X.XXX,XX" or "X.XXX.XXX,XX" with a
  // single normalized form: strip dots (thousands
  // sep), replace comma with dot.
  const normalized = trimmed
    .replace(/\./g, '')
    .replace(',', '.')
  const n = Number(normalized)
  if (!Number.isFinite(n)) return null
  return n
}

/**
 * Auto-detect the Vg type from a free-text
 * description. Tries to find a ticker symbol in the
 * string — uppercase word of 1-5 chars, surrounded
 * by non-letters. The ticker map is the source of
 * truth; an unknown uppercase word defaults to
 * "wertpapier" (broker assumption: most bank-export
 * rows with explicit tickers are listed stocks, and
 * crypto exchanges always tag rows with BTC/ETH
 * which we recognise above).
 */
function detectType(description: string, explicit?: string): VgKind {
  // Tier 664: four kinds; crypto is its own (it was filed as a security to
  // get the one-year period), and what is neither a known security nor
  // crypto is an "other asset" — one year, not ten.
  if (VG_KINDS.includes(explicit as VgKind)) return explicit as VgKind
  if (looksLikeCrypto(description)) return 'krypto'
  const tokens = (description || '').toUpperCase().match(/[A-Z0-9]{1,6}/g) || []
  for (const t of tokens) {
    if (CRYPTO_TICKERS.has(t)) return 'krypto'
    if (SECURITY_TICKERS.has(t)) return 'wertpapier'
  }
  return 'sonstige'
}

/**
 * Compute a single CSV row into a (preview) VgTransaction.
 * Pure function — no DB, no IO. Used by the preview
 * endpoint and the confirm endpoint (deterministic so
 * the preview matches the actual import).
 */
function parseCsvRow(
  raw: Record<string, string>,
  rowIndex: number,
): CsvPreviewRow {
  const warnings: string[] = []
  const explicitType = (raw.type || '').trim().toLowerCase()
  const description = (raw.description || '').trim()

  const acqDate = parseDeDate(raw.acquisitiondate || '')
  if (!acqDate) {
    warnings.push(`row ${rowIndex}: acquisitionDate ungültig (${raw.acquisitiondate})`)
  }
  const saleDate = parseDeDate(raw.saledate || '')
  if (!saleDate) {
    warnings.push(`row ${rowIndex}: saleDate ungültig (${raw.saledate})`)
  }
  const acqCost = parseDeDecimal(raw.acquisitioncost || '')
  if (acqCost === null) {
    warnings.push(`row ${rowIndex}: acquisitionCost ungültig (${raw.acquisitioncost})`)
  }
  const salePrice = parseDeDecimal(raw.saleprice || '')
  if (salePrice === null) {
    warnings.push(`row ${rowIndex}: salePrice ungültig (${raw.saleprice})`)
  }

  const type: VgKind = detectType(description, explicitType)

  const ok = !!acqDate && !!saleDate && acqCost !== null && salePrice !== null

  return {
    rowIndex,
    raw,
    ok,
    warnings,
    transaction: {
      type,
      description,
      acquisitionDate: acqDate || '',
      acquisitionCost: acqCost ?? 0,
      saleDate: saleDate || '',
      salePrice: salePrice ?? 0,
      v: 2,
    },
  }
}

@Injectable()
export class AnlageSOV2Service {
  constructor(private prisma: PrismaService) {}

  /**
   * v2 compute: extends v1 with the loss-verrechnung
   * block (inFristGain / inFristLoss / priorYearLoss /
   * totalTaxableGain / carryforward) and stores the
   * computed carryforward on
   * Company.settings.anlageSOLossCarryforward[year].
   * Re-uses v1's transaction normalization + the
   * BMF Kz lines.
   */
  async compute(companyId: string, year: number) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true, name: true },
    })
    if (!company) {
      throw new NotFoundException('Firma nicht gefunden')
    }
    const settings = (company.settings as any) || {}
    const anlageSoAll = (settings.anlageSO as any) || {}
    const yearData = anlageSoAll[year] || {}
    const carryforwardMap = (settings.anlageSOLossCarryforward as any) || {}
    const priorYearLoss = Number(carryforwardMap[year - 1]) || 0

    // Tier 665: every stored row comes back (`rows`); the sales of the year
    // that are complete are counted (`transactions`)
    const { counted: transactions, rows } = splitRows(yearData.transactions, year)

    const wiederkehrendeBezuege = Number(yearData.wiederkehrendeBezuege) || 0
    const werbungskosten = Number(yearData.werbungskosten) || 0

    // Tier 664: by the rules of § 23 (anlage-so-rules.ts) — each sale by its
    // kind's period, securities bought since 2009 left to Anlage KAP, the
    // year's losses and a loss carried forward set off, then the Freigrenze.
    const sum = vgSummary(transactions, year, priorYearLoss)
    const inFristGain = sum.gain
    const inFristLoss = sum.loss
    const inFristCount = sum.countTaxable
    const outOfFristCount = sum.countFree
    const totalTaxableGain = sum.net
    const carryforward = sum.carryforward
    // Tier 656: less than the limit of the year (was: ≤ 600 for every year)
    const freigrenzeApplied = sum.taxable === 0
    const vgTotal = freigrenzeApplied ? 0 : totalTaxableGain

    // v2: persist the carryforward for next year (if
    // > 0). Skip on 0 — no need to store "no carry".
    // We always recompute from the canonical in-Frist
    // gain/loss pair, not from the stored value (the
    // stored value is for the *next* year's view).
    if (carryforward > 0 || carryforwardMap[year] !== undefined) {
      const nextCarry = { ...carryforwardMap }
      if (carryforward > 0) {
        nextCarry[year] = round2(carryforward)
      } else {
        delete nextCarry[year]
      }
      await this.prisma.company.update({
        where: { id: companyId },
        data: {
          settings: { ...settings, anlageSOLossCarryforward: nextCarry },
        } as any,
      })
      // Reflect locally for the response below.
      Object.assign(carryforwardMap, { [year]: nextCarry[year] ?? undefined })
    }

    // The BMF Kz lines — same as v1, but the v2
    // Kz 20 (Freigrenze) is always 600 when there's
    // any in-Frist activity (gain OR loss). v1 only
    // showed 600 when taxableGain > 0. v2 shows it
    // whenever inFristCount > 0 because the
    // Freigrenze applies to the post-loss-offset
    // total, and the "0 if applied else total" rule
    // is the same identity.
    const lines: Array<{
      kennziffer: string
      label: string
      amount: number
      source: 'computed' | 'placeholder'
      note?: string
    }> = [
      {
        kennziffer: '32',
        label:
          'Wertpapiere, vor 2009 angeschafft (§ 23 Abs. 1 Nr. 2 EStG a. F.) — seit 2009 angeschaffte gehören in die Anlage KAP',
        amount: sum.gainByKind.wertpapier,
        source: 'computed',
        ...(sum.countKap > 0
          ? { note: `${sum.countKap} Geschäft(e) mit seit 2009 angeschafften Wertpapieren sind hier nicht angesetzt — ihr Ergebnis (${this.fmtEur(sum.gainKap)} €) ist Kapitalertrag (§ 20 Abs. 2 EStG, Anlage KAP), unabhängig von der Haltedauer.` }
          : {}),
      },
      {
        kennziffer: '34',
        label:
          'Veräußerung von Kryptowerten / Token (§ 23 Abs. 1 Nr. 2 EStG) — Frist ein Jahr',
        amount: sum.gainByKind.krypto,
        source: 'computed',
      },
      {
        kennziffer: '41',
        label:
          'Veräußerung anderer Wirtschaftsgüter (§ 23 Abs. 1 Nr. 2 EStG) — Gold, Kunst, Schmuck, Uhren, Antiquitäten etc., Frist ein Jahr',
        amount: sum.gainByKind.sonstige,
        source: 'computed',
      },
      {
        kennziffer: '43',
        label:
          'Veräußerung von Grundstücken / Immobilien im Privatvermögen (§ 23 Abs. 1 Nr. 1 EStG) — Frist zehn Jahre',
        amount: sum.gainByKind.grundstueck,
        source: 'computed',
        note: 'Ausgenommen ist das selbst bewohnte Haus (§ 23 Abs. 1 Nr. 1 Satz 3 EStG) — der Berater prüft das.',
      },
      {
        kennziffer: '20',
        label:
          'Freigrenze für private Veräußerungsgeschäfte (§ 23 Abs. 3 Satz 5 EStG): unter 1.000 EUR Gesamtgewinn im Jahr steuerfrei (bis 2023: 600 EUR)',
        amount: inFristCount > 0 ? freigrenzeFor(year) : 0,
        source: 'computed',
      },
      // v2 NEW: Kz 99 — Verlustvortrag / Verlustverrechnung
      {
        kennziffer: '99',
        label:
          'Verlustverrechnung / Verlustvortrag (§ 23 Abs. 3 Satz 3-4 EStG) — In-Frist-Verluste des Vorjahrs (Rücktrag) + Saldo Verlustvortrag in Folgejahre',
        amount: 0, // populated by the loss-verrechnung block below
        source: 'computed',
        note:
          'Betrag = max(0, inFristLoss + priorYearLoss − inFristGain). Wird als Verlustvortrag gespeichert und im Folgejahr automatisch verrechnet (§ 23 Abs. 3 Satz 4 EStG).',
      },
      {
        kennziffer: '11',
        label:
          'Wiederkehrende Bezüge (§ 22 Nr. 1 EStG) — private Pensionen, Versorgungsleistungen, Unterhaltsleistungen',
        amount: round2(wiederkehrendeBezuege),
        source: 'computed',
      },
      {
        kennziffer: '12',
        label:
          'Werbungskosten-Pauschbetrag bei wiederkehrenden Bezügen — 102 EUR (gesetzliche Renten) bzw. tatsächliche Werbungskosten',
        amount: round2(werbungskosten),
        source: 'computed',
      },
    ]
    // Populate Kz 99 with the negative side of the
    // loss-verrechnung (the loss that was either
    // netted against gains or carried forward).
    const kz99 = lines.find((l) => l.kennziffer === '99')
    if (kz99) {
      // Display the carryforward as a positive
      // (the PDF footer's "Verlustvortrag" line
      // shows the same number, positive).
      kz99.amount = round2(carryforward)
    }

    const einkuenfte = round2(
      vgTotal + wiederkehrendeBezuege - werbungskosten,
    )

    return {
      year,
      companyId,
      transactions,
      rows,
      wiederkehrendeBezuege,
      werbungskosten,
      vg: {
        count: transactions.length,
        countNotCounted: rows.length - transactions.length,
        countWertpapier: sum.countByKind.wertpapier,
        countSonstige: sum.countByKind.sonstige,
        countKrypto: sum.countByKind.krypto,
        countGrundstueck: sum.countByKind.grundstueck,
        countKap: sum.countKap,
        gainKap: sum.gainKap,
        inFristCount,
        outOfFristCount,
        inFristGain: round2(inFristGain),
        inFristLoss: round2(inFristLoss),
        priorYearLoss: round2(priorYearLoss),
        totalTaxableGain: round2(totalTaxableGain),
        carryforward: round2(carryforward),
        freigrenzeApplied,
        vgTotal: round2(vgTotal),
      },
      freigrenze: freigrenzeFor(year),
      lines,
      totals: {
        vgTotal: round2(vgTotal),
        wiederkehrendeBezuegeTotal: round2(wiederkehrendeBezuege),
        werbungskostenTotal: round2(werbungskosten),
        einkuenfte,
      },
      counts: {
        hasVg: transactions.length > 0,
        hasWiederkehrende: wiederkehrendeBezuege > 0,
        hasLoss: inFristLoss > 0 || priorYearLoss > 0,
        hasCarryforward: carryforward > 0,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihren privaten ' +
        'Veräußerungsgeschäften und wiederkehrenden Bezügen ' +
        '(erfasst unter Buchhaltung, Anlage SO) generiert. ' +
        'Vollständige Verlustverrechnung nach § 23 Abs. 3 ' +
        'Satz 3-5 EStG — in-Frist-Verluste werden mit in-Frist-' +
        'Gewinnen verrechnet; der nicht verrechnigte Anteil wird ' +
        'als Verlustvortrag ' +
        'in das Folgejahr übernommen. Die Freigrenze (§ 23 ' +
        'Abs. 3 Satz 5 EStG) wird NACH Verlustverrechnung ' +
        'angewendet: unter 1.000 EUR (bis 2023: 600 EUR) steuerfrei, ab der Grenze in voller Höhe steuerpflichtig. ' +
        'Grundstücke sind zehn Jahre nach der Anschaffung steuerverstrickt (§ 23 Abs. 1 Nr. 1 EStG), ' +
        'andere Wirtschaftsgüter — Gold, Kunst, Kryptowerte — ein Jahr (Nr. 2). Wertpapiere, die seit 2009 ' +
        'angeschafft wurden, gehören nicht hierher: ihr Ergebnis ist Kapitalertrag (§ 20 Abs. 2 EStG, Anlage KAP) ' +
        'und wird hier nicht angesetzt. Nicht berücksichtigt: das selbst bewohnte Haus und die auf zehn Jahre ' +
        'verlängerte Frist für Wirtschaftsgüter, die als Einkunftsquelle genutzt wurden — der Berater prüft das. ' +
        'Die Geschäfte lassen sich als CSV-Datei einlesen (Buchhaltung, Anlage SO).',
    }
  }

  /**
   * v2: Read the loss carryforward for a given year.
   * Returns the stored number (or 0). Used by the
   * UI summary line and by the e2e test.
   */
  async getLossCarryforward(companyId: string, year: number): Promise<{
    year: number
    companyId: string
    priorYearLoss: number
    currentYearLoss: number
    carryforward: number
  }> {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    if (!company) throw new NotFoundException('Firma nicht gefunden')
    const settings = (company.settings as any) || {}
    const carryforwardMap = (settings.anlageSOLossCarryforward as any) || {}
    const priorYearLoss = Number(carryforwardMap[year - 1]) || 0
    const currentYearLoss = Number(carryforwardMap[year]) || 0
    // The "carryforward" for year N is what was stored
    // at the end of year N (the value that will be
    // picked up as `priorYearLoss` in N+1). It equals
    // currentYearLoss when this lookup is run AFTER
    // the year's compute().
    return {
      year,
      companyId,
      priorYearLoss: round2(priorYearLoss),
      currentYearLoss: round2(currentYearLoss),
      carryforward: round2(currentYearLoss),
    }
  }

  /**
   * v2: CSV import — preview or confirm.
   * The CSV shape:
   *   type,description,acquisitionDate,acquisitionCost,saleDate,salePrice
   *   (header row REQUIRED; type is optional and
   *   auto-detected from description when missing)
   *
   * Body:
   *   {
   *     companyId, year,
   *     csv: '<csv text>',
   *     previewOnly: bool,    // default true
   *     replace: bool         // default false;
   *                            // if true, the existing
   *                            // transactions for the
   *                            // year are replaced
   *                            // with the parsed CSV
   *                            // rows (dedup is then
   *                            // trivially 0)
   *   }
   *
   * Response (previewOnly=true):
   *   {
   *     preview: CsvPreviewRow[],
   *     okCount: number,
   *     warningCount: number,
   *     duplicateCount: number
   *   }
   *
   * Response (previewOnly=false):
   *   CsvImportResult
   *   (importedCount = number of new rows persisted,
   *    skippedCount = duplicates in the existing
   *    transactions, transactions = the post-merge
   *    array)
   */
  async importCsv(
    companyId: string,
    year: number,
    csv: string,
    previewOnly: boolean,
    replace: boolean,
  ): Promise<
    | {
        preview: CsvPreviewRow[]
        okCount: number
        warningCount: number
        duplicateCount: number
      }
    | CsvImportResult
  > {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    if (!csv || typeof csv !== 'string' || !csv.trim()) {
      throw new BadRequestException('csv ist erforderlich')
    }

    // 1. Parse the CSV (RFC 4180 lite: handle quoted
    //    fields with embedded commas + newlines).
    const rows = parseCsvText(csv)
    if (rows.length === 0) {
      throw new BadRequestException('CSV enthält keine Daten')
    }
    const header = rows[0].map((h) => h.trim().toLowerCase())
    const expected = [
      'type',
      'description',
      'acquisitiondate',
      'acquisitioncost',
      'saledate',
      'saleprice',
    ]
    // Allow case-insensitive header names. The user
    // is allowed to omit the `type` column (then we
    // auto-detect); the rest are required.
    for (const col of expected) {
      if (col === 'type') continue // optional
      if (!header.includes(col)) {
        throw new BadRequestException(
          `CSV-Spalte "${col}" fehlt (erforderliche Spalten: type?, description, acquisitionDate, acquisitionCost, saleDate, salePrice)`,
        )
      }
    }

    // 2. Project rows → object-with-known-keys.
    const dataRows = rows.slice(1).filter((r) =>
      r.some((c) => (c || '').trim() !== ''),
    )
    const preview: CsvPreviewRow[] = dataRows.map((cells, idx) => {
      const obj: Record<string, string> = {}
      header.forEach((h, i) => {
        obj[h] = (cells[i] || '').trim()
      })
      return parseCsvRow(obj, idx + 1)
    })

    // Tier 665: a sale of another year does not belong in this year's list
    // (it was imported, left out of every sum and deleted by the form's
    // next save)
    for (const p of preview) {
      const saleYear = p.transaction.saleDate.slice(0, 4)
      if (p.ok && Number(saleYear) !== year) {
        p.ok = false
        p.warnings.push(`row ${p.rowIndex}: veräußert ${saleYear} — gehört in die Anlage SO ${saleYear}, nicht ${year}`)
      }
    }

    if (previewOnly) {
      // Dedupe is informational only at preview time:
      // a duplicate is a (description + acquisitionDate
      // + saleDate) triple that already exists for
      // the company-year.
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { settings: true },
      })
      const existing = ((company?.settings as any)?.anlageSO?.[year]?.transactions as any[]) || []
      const existingKey = new Set(
        existing
          .filter((t: any) => t && t.description && t.acquisitionDate && t.saleDate)
          .map((t: any) => `${t.description}__${t.acquisitionDate}__${t.saleDate}`),
      )
      let duplicateCount = 0
      for (const p of preview) {
        if (!p.ok) continue
        const key = `${p.transaction.description}__${p.transaction.acquisitionDate}__${p.transaction.saleDate}`
        if (existingKey.has(key)) {
          duplicateCount++
          p.warnings.push(`Duplikat: bereits im Jahr ${year} vorhanden`)
        }
      }
      const okCount = preview.filter((p) => p.ok && p.warnings.every((w) => !w.startsWith('Duplikat'))).length
      const warningCount = preview.filter((p) => p.warnings.length > 0).length
      return { preview, okCount, warningCount, duplicateCount }
    }

    // 3. Confirm path: persist.
    const okRows = preview.filter((p) => p.ok)
    if (okRows.length === 0) {
      throw new BadRequestException('CSV enthält keine gültigen Zeilen')
    }
    const newTransactions: VgTransaction[] = okRows.map((p) => p.transaction)
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) throw new NotFoundException('Firma nicht gefunden')
    const settings = ((company as any).settings ?? {}) as Record<string, any>
    const anlageSoAll = (settings.anlageSO as any) || {}
    const yearData = anlageSoAll[year] || {}
    const existing: VgTransaction[] = Array.isArray(yearData.transactions)
      ? yearData.transactions
      : []

    let merged: VgTransaction[]
    let skippedCount = 0
    if (replace) {
      merged = newTransactions
    } else {
      const seen = new Set(
        existing
          .filter((t) => t.description && t.acquisitionDate && t.saleDate)
          .map((t) => `${t.description}__${t.acquisitionDate}__${t.saleDate}`),
      )
      const newOnes: VgTransaction[] = []
      for (const t of newTransactions) {
        const k = `${t.description}__${t.acquisitionDate}__${t.saleDate}`
        if (seen.has(k)) {
          skippedCount++
          continue
        }
        seen.add(k)
        newOnes.push(t)
      }
      merged = existing.concat(newOnes)
    }

    anlageSoAll[year] = {
      ...yearData,
      transactions: merged,
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { settings: { ...settings, anlageSO: anlageSoAll } } as any,
    })
    return {
      importedCount: replace ? newTransactions.length : newTransactions.length - skippedCount,
      skippedCount,
      transactions: merged,
    }
  }

  /**
   * The expenses that are a purchase of crypto or of securities: the
   * category the user typed, in German or English, whatever the case. Up to
   * the end of the year — what is sold this year was often bought earlier.
   */
  private purchaseWhere(companyId: string, year: number) {
    return {
      companyId,
      invoiceDate: { lte: new Date(`${year}-12-31T23:59:59.999Z`) },
      OR: [...CRYPTO_CATEGORY, ...SECURITY_CATEGORY].map((word) => ({
        category: { startsWith: word, mode: 'insensitive' as const },
      })),
    }
  }

  /** The expenses already taken over — into any year's list. */
  private importedExpenseIds(settings: Record<string, any>): Set<string> {
    const ids = new Set<string>()
    for (const yearData of Object.values((settings.anlageSO as Record<string, any>) || {})) {
      for (const t of Array.isArray(yearData?.transactions) ? yearData.transactions : []) {
        const id = t?.metadata?.importedFromExpenseId
        if (typeof id === 'string' && id) ids.add(id)
      }
    }
    return ids
  }

  /**
   * Takes expenses over as the ACQUISITION of an asset: the expense's date and
   * amount are the acquisition date and cost. The sale is left open — the
   * user enters it, and until then the row is not counted.
   *
   * Tier 665. Before, every expense became a sale: sold on the day of the
   * expense for the amount of the expense, "acquired" a month earlier for
   * the same amount — a sale that had not taken place, with an acquisition
   * date nobody had entered, printed on the preview for the adviser. And
   * the page's checkboxes chose nothing: every expense was taken.
   *
   * `ids`: the expenses chosen; without it, all that were not taken yet.
   */
  async importFromExpenses(
    companyId: string,
    year: number,
    ids?: string[],
  ): Promise<CsvImportResult> {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) throw new NotFoundException('Firma nicht gefunden')
    const settings = ((company as any).settings ?? {}) as Record<string, any>
    const anlageSoAll = (settings.anlageSO as any) || {}
    const yearData = anlageSoAll[year] || {}
    const existing: VgTransaction[] = Array.isArray(yearData.transactions)
      ? yearData.transactions
      : []
    const importedFromIds = this.importedExpenseIds(settings)

    const expenses = await this.prisma.expense.findMany({
      where: { ...this.purchaseWhere(companyId, year), ...(ids ? { id: { in: ids } } : {}) },
      orderBy: { invoiceDate: 'asc' },
      take: 500,
    })

    const newTransactions: VgTransaction[] = []
    let skippedCount = 0
    for (const e of expenses) {
      if (importedFromIds.has(e.id)) {
        skippedCount++
        continue
      }
      newTransactions.push({
        type: isCryptoCategory(e.category) ? 'krypto' : 'wertpapier',
        description: e.invoiceNumber
          ? `${e.invoiceNumber} — ${e.description}`
          : e.description,
        acquisitionDate: e.invoiceDate.toISOString().slice(0, 10),
        acquisitionCost: Number(e.grossAmount) || 0,
        saleDate: '',
        salePrice: 0,
        v: 2,
        metadata: {
          importedFromExpenseId: e.id,
          importedAt: new Date().toISOString(),
        },
      })
    }

    const merged = existing.concat(newTransactions)
    anlageSoAll[year] = {
      ...yearData,
      transactions: merged,
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { settings: { ...settings, anlageSO: anlageSoAll } } as any,
    })
    return {
      importedCount: newTransactions.length,
      skippedCount,
      transactions: merged,
    }
  }

  /**
   * The expenses that can be taken over (the page's list), newest first,
   * each with whether it was taken already.
   */
  async listImportableExpenses(companyId: string, year: number) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) throw new NotFoundException('Firma nicht gefunden')
    const settings = ((company as any).settings ?? {}) as Record<string, any>
    const importedFromIds = this.importedExpenseIds(settings)
    const expenses = await this.prisma.expense.findMany({
      where: this.purchaseWhere(companyId, year),
      orderBy: { invoiceDate: 'desc' },
      take: 500,
    })
    return {
      year,
      items: expenses.map((e) => ({
        id: e.id,
        invoiceNumber: e.invoiceNumber,
        description: e.description,
        category: e.category,
        invoiceDate: e.invoiceDate.toISOString().slice(0, 10),
        grossAmount: Number(e.grossAmount),
        alreadyImported: importedFromIds.has(e.id),
      })),
    }
  }

  /**
   * v2: PDF renderer — same as v1 but adds the
   * loss-verrechnung summary block (inFristGain /
   * inFristLoss / priorYearLoss / carryforward).
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = flowFromLeft(new PDFDocument({ size: 'A4', margin: 40 }))
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-SO-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage SO ${year} — VORSCHAU`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Sonstige Einkünfte (§ 22 EStG) — ${company?.name || companyId}`,
      )
      .moveDown(1)

    // v2: Loss-verrechnung summary block (printed
    // above the transactions list so the Berater
    // sees the math first).
    if (data.vg.inFristCount > 0) {
      doc.fontSize(11).font('Helvetica-Bold').text('Verlustverrechnung (§ 23 Abs. 3 EStG)')
      doc.moveDown(0.2)
      doc.fontSize(9).font('Helvetica')
      doc.text(`• In-Frist-Gewinne (§ 23 Abs. 3 Satz 3): ${this.fmtEur(data.vg.inFristGain)} €`)
      doc.text(`• In-Frist-Verluste: ${this.fmtEur(data.vg.inFristLoss)} €`)
      doc.text(`• Verlustvortrag aus Vorjahr: ${this.fmtEur(data.vg.priorYearLoss)} €`)
      doc.text(`• Verbleibender steuerpflichtiger Gewinn: ${this.fmtEur(data.vg.totalTaxableGain)} €`)
      if (data.vg.carryforward > 0) {
        doc.text(`• Verlustvortrag in Folgejahre: ${this.fmtEur(data.vg.carryforward)} €`)
      }
      if (data.vg.freigrenzeApplied) {
        doc.text(`• Freigrenze (${freigrenzeFor(year)} EUR) angewendet — vgTotal = 0`)
      } else {
        doc.text(`• Freigrenze überschritten — vgTotal = ${this.fmtEur(data.vg.vgTotal)} €`)
      }
      doc.moveDown(1)
    }

    if (!data.counts.hasVg && !data.counts.hasWiederkehrende) {
      doc
        .fontSize(10)
        .font('Helvetica-Oblique')
        .fillColor('#b45309')
        .text(
          '⚠ Keine privaten Veräußerungsgeschäfte oder ' +
            'wiederkehrenden Bezüge für dieses Jahr erfasst. ' +
            'Tragen Sie unten Ihre Veräußerungen (Krypto, ' +
            'Gold, Aktien, etc.) und / oder wiederkehrenden ' +
            'Bezüge (private Pensionen, Unterhalt) ein.',
        )
        .fillColor('#000')
      doc.moveDown(1)
    }

    if (data.rows.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Private Veräußerungsgeschäfte (§ 23 EStG)')
      doc.moveDown(0.3)
      doc.fontSize(8).font('Helvetica')
      for (const t of data.rows) doc.text(rowLine(t))
      doc.moveDown(1)
    }

    if (data.wiederkehrendeBezuege > 0 || data.werbungskosten > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Wiederkehrende Bezüge (§ 22 Nr. 1 EStG)')
      doc.moveDown(0.3)
      doc.fontSize(9).font('Helvetica')
      doc.text(`• Bezüge: ${this.fmtEur(data.wiederkehrendeBezuege)} €`)
      doc.text(`• Werbungskosten: ${this.fmtEur(data.werbungskosten)} €`)
      doc.moveDown(1)
    }

    doc.fontSize(12).font('Helvetica-Bold').text('BMF Vordruck Anlage SO 2024 — Kennziffern')
    doc.moveDown(0.3)
    this.renderTable(doc, data.lines, data.totals, data.freigrenze)
    doc.moveDown(1)

    doc.fontSize(13).font('Helvetica-Bold')
    doc.text(
      `Σ Einkünfte (§ 22 EStG): ${this.fmtEur(data.totals.einkuenfte)} €`,
    )
    doc.moveDown(1)

    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .fillColor('#666')
      .text(data.disclaimer, { width: 515 })
      .fillColor('#000')

    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#999')
      .text(
        `Erstellt: ${new Date(data.generatedAt).toLocaleString('de-DE')}  |  ` +
          `de-invoice · Anlage SO Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: Array<{
      kennziffer: string
      label: string
      amount: number
      source: 'computed' | 'placeholder'
      note?: string
    }>,
    totals: { vgTotal: number; wiederkehrendeBezuegeTotal: number; werbungskostenTotal: number; einkuenfte: number },
    _freigrenze: number,
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
    doc.text('Einkünfte nach Berücksichtigung der Freigrenze', colKz + 35, doc.y, {
      width: 320,
    })
    doc.text(this.fmtEur(totals.einkuenfte), colAmount, doc.y, {
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

/**
 * Tiny RFC 4180-ish CSV parser. Handles:
 *   - quoted fields: "He said ""hi"", ok"
 *   - newlines inside quotes
 *   - trailing empty rows (skipped)
 *   - both \n and \r\n
 * Returns: array-of-arrays, all as strings.
 */
export function parseCsvText(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (c === '\n' || c === '\r') {
      // Handle CRLF
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((v) => v !== '')) out.push(row)
      row = []
      continue
    }
    field += c
  }
  // Trailing field
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.some((v) => v !== '')) out.push(row)
  }
  return out
}
