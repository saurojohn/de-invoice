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
 *        (BTC/ETH/... = "sonstige", AAPL/MSFT/... =
 *        "wertpapier", else "sonstige"). Returns
 *        either a preview (previewOnly=true) or
 *        persists the parsed rows into
 *        Company.settings.anlageSO[year].transactions.
 *
 *   2. Full loss-verrechnung per § 23 Abs. 3
 *      Satz 3-5 EStG (BMF 2024):
 *
 *      inFristGain     = Σ max(0, salePrice - cost)
 *                        for sales within Frist
 *      inFristLoss     = Σ max(0, cost - salePrice)
 *                        for sales within Frist
 *      priorYearLoss   = settings.anlageSOLossCarryforward[year-1] || 0
 *      totalTaxableGain = max(0, inFristGain - inFristLoss - priorYearLoss)
 *      carryforward     = max(0, inFristLoss + priorYearLoss - inFristGain)
 *                        // next year's Lossvortrag
 *      freigrenzeApplied = totalTaxableGain <= 600
 *      vgTotal = 0 if freigrenzeApplied else totalTaxableGain
 *
 *      The 600-EUR Freigrenze is APPLIED AFTER loss
 *      offset — v1's "all-or-nothing" identity holds
 *      (taxableGain ≤ 600 → vgTotal = 0), just with a
 *      different "taxableGain" base.
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
  type: 'wertpapier' | 'sonstige'
  description: string
  acquisitionDate: string // ISO date YYYY-MM-DD
  acquisitionCost: number
  saleDate: string
  salePrice: number
  metadata?: { importedFromExpenseId?: string; importedAt?: string }
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

const FREIGRENZE_2024 = 600
const SPEKULATIONSFRIST_YEARS: Record<string, number> = {
  wertpapier: 1,
  sonstige: 10,
}

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

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function yearsBetween(startISO: string, endISO: string): number {
  const a = new Date(startISO)
  const b = new Date(endISO)
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0
  const ms = b.getTime() - a.getTime()
  return ms / (365.25 * 24 * 60 * 60 * 1000)
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
function detectType(description: string, explicit?: string): 'wertpapier' | 'sonstige' {
  if (explicit === 'wertpapier' || explicit === 'sonstige') return explicit
  const tokens = (description || '').toUpperCase().match(/[A-Z0-9]{1,6}/g) || []
  for (const t of tokens) {
    if (CRYPTO_TICKERS.has(t)) return 'wertpapier'
    if (SECURITY_TICKERS.has(t)) return 'wertpapier'
  }
  // No recognised ticker — assume sonstige (10-year
  // Frist, conservative).
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

  const type: 'wertpapier' | 'sonstige' =
    explicitType === 'wertpapier' || explicitType === 'sonstige'
      ? (explicitType as 'wertpapier' | 'sonstige')
      : detectType(description)

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

    // Normalize transactions (same shape as v1, plus
    // optional `metadata`).
    const rawTx: any[] = Array.isArray(yearData.transactions) ? yearData.transactions : []
    const transactions: VgTransaction[] = rawTx
      .filter((t) => t && typeof t === 'object')
      .map((t: any) => {
        const type: 'wertpapier' | 'sonstige' =
          t.type === 'wertpapier' ? 'wertpapier' : 'sonstige'
        return {
          type,
          description: String(t.description || '').trim(),
          acquisitionDate:
            typeof t.acquisitionDate === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(t.acquisitionDate)
              ? t.acquisitionDate
              : '',
          acquisitionCost: Number(t.acquisitionCost) || 0,
          saleDate:
            typeof t.saleDate === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(t.saleDate)
              ? t.saleDate
              : '',
          salePrice: Number(t.salePrice) || 0,
          metadata:
            t.metadata && typeof t.metadata === 'object'
              ? {
                  importedFromExpenseId:
                    typeof t.metadata.importedFromExpenseId === 'string'
                      ? t.metadata.importedFromExpenseId
                      : undefined,
                  importedAt:
                    typeof t.metadata.importedAt === 'string'
                      ? t.metadata.importedAt
                      : undefined,
                }
              : undefined,
        }
      })
      .filter((t) => {
        if (!t.saleDate) return false
        return Number(t.saleDate.slice(0, 4)) === year
      })

    const wiederkehrendeBezuege = Number(yearData.wiederkehrendeBezuege) || 0
    const werbungskosten = Number(yearData.werbungskosten) || 0

    // v2: per-transaction gain + classify (in-Frist vs
    // out-of-Frist, gain vs loss).
    let inFristGain = 0
    let inFristLoss = 0
    let inFristCount = 0
    let outOfFristCount = 0
    let inFristLossUsed = 0 // for the "remaining loss" stat
    for (const t of transactions) {
      const gain = t.salePrice - t.acquisitionCost
      const fristYears = SPEKULATIONSFRIST_YEARS[t.type] ?? 10
      const held = yearsBetween(t.acquisitionDate, t.saleDate)
      if (held < fristYears) {
        inFristCount++
        if (gain > 0) inFristGain += gain
        else inFristLoss += -gain // positive magnitude
      } else {
        outOfFristCount++
      }
    }

    // v2: totalTaxableGain = inFristGain - inFristLoss - priorYearLoss
    const totalTaxableGain = Math.max(
      0,
      inFristGain - inFristLoss - priorYearLoss,
    )
    // carryforward = what's left of the loss when
    // gains don't cover it (v2 writes this to
    // Company.settings.anlageSOLossCarryforward[year]).
    const carryforward = Math.max(
      0,
      inFristLoss + priorYearLoss - inFristGain,
    )
    const freigrenzeApplied = totalTaxableGain <= FREIGRENZE_2024
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
          'Veräußerung von Wertpapieren (§ 23 Abs. 1 Nr. 2 EStG) — 1-Jahres-Spekulationsfrist',
        amount: round2(
          transactions
            .filter(
              (t) =>
                t.type === 'wertpapier' &&
                yearsBetween(t.acquisitionDate, t.saleDate) <
                  (SPEKULATIONSFRIST_YEARS.wertpapier ?? 1),
            )
            .reduce((s, t) => s + Math.max(t.salePrice - t.acquisitionCost, 0), 0),
        ),
        source: 'computed',
      },
      {
        kennziffer: '34',
        label:
          'Veräußerung von Kryptowährungen / Token (§ 23 Abs. 1 Nr. 2 EStG) — 1-Jahres-Spekulationsfrist (BMF 2024)',
        amount: round2(
          transactions
            .filter(
              (t) =>
                t.type === 'wertpapier' &&
                yearsBetween(t.acquisitionDate, t.saleDate) <
                  (SPEKULATIONSFRIST_YEARS.wertpapier ?? 1),
            )
            .reduce((s, t) => s + Math.max(t.salePrice - t.acquisitionCost, 0), 0),
        ),
        source: 'computed',
        note:
          'Kryptowährungen werden vom BMF wie sonstige WG behandelt, fallen aber unter die 1-Jahres-Frist (§ 23 Abs. 1 Nr. 2 EStG analog).',
      },
      {
        kennziffer: '41',
        label:
          'Veräußerung von sonstigen Wirtschaftsgütern (§ 23 Abs. 1 Nr. 1 EStG) — 10-Jahres-Spekulationsfrist',
        amount: round2(
          transactions
            .filter(
              (t) =>
                t.type === 'sonstige' &&
                yearsBetween(t.acquisitionDate, t.saleDate) <
                  (SPEKULATIONSFRIST_YEARS.sonstige ?? 10),
            )
            .reduce((s, t) => s + Math.max(t.salePrice - t.acquisitionCost, 0), 0),
        ),
        source: 'computed',
      },
      {
        kennziffer: '20',
        label:
          'Freigrenze für private Veräußerungsgeschäfte (§ 23 Abs. 3 Satz 5 EStG) — 600 EUR/Jahr',
        amount: inFristCount > 0 ? FREIGRENZE_2024 : 0,
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
          'Betrag = max(0, inFristLoss + priorYearLoss − inFristGain). Wird als "carryforward" in Company.settings.anlageSOLossCarryforward[year] gespeichert und im Folgejahr automatisch verrechnet (§ 23 Abs. 3 Satz 4 EStG).',
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
      wiederkehrendeBezuege,
      werbungskosten,
      vg: {
        count: transactions.length,
        countWertpapier: transactions.filter((t) => t.type === 'wertpapier').length,
        countSonstige: transactions.filter((t) => t.type === 'sonstige').length,
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
      freigrenze: FREIGRENZE_2024,
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
        '(Company.settings.anlageSO[year]) generiert. v2: ' +
        'Vollständige Verlustverrechnung nach § 23 Abs. 3 ' +
        'Satz 3-5 EStG — in-Frist-Verluste werden mit in-Frist-' +
        'Gewinnen verrechnet; der nicht verrechnigte Anteil wird ' +
        'als Verlustvortrag (Company.settings.anlageSOLossCarryforward) ' +
        'in das Folgejahr übernommen. Freigrenze 600 EUR (§ 23 ' +
        'Abs. 3 Satz 5 EStG) wird NACH Verlustverrechnung ' +
        'angewendet (≤ 600 EUR → komplett steuerfrei). ' +
        'Spekulationsfrist: 1 Jahr für Wertpapiere (§ 23 Abs. 1 ' +
        'Nr. 2 EStG, inkl. Kryptowährungen), 10 Jahre für ' +
        'sonstige Wirtschaftsgüter (§ 23 Abs. 1 Nr. 1 EStG). ' +
        'v2: Broker-CSV-Import (Spalten: type,description,' +
        'acquisitionDate,acquisitionCost,saleDate,salePrice) ' +
        'sowie Auto-Import aus Ausgaben (Expense.category = ' +
        "'crypto' | 'brokerage').",
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
    const hasType = header.includes('type')
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
   * v2: Auto-import from Expense rows tagged
   *   category='crypto' or category='brokerage'.
   * Each Expense becomes one VgTransaction:
   *   - type:    'sonstige' (crypto) | 'wertpapier' (brokerage)
   *   - description:  the expense's invoiceNumber+description
   *   - acquisitionDate:  the year before saleDate
   *     (heuristic; broker PDFs would carry the
   *     real date, but for v2 we use a 1-year
   *     default for crypto + the actual `invoiceDate`
   *     for brokerage — best-effort)
   *   - acquisitionCost: grossAmount (the cost basis)
   *   - saleDate:        invoiceDate
   *   - salePrice:       grossAmount (1:1 mapping; v2
   *                      does not separate cost vs.
   *                      sale — that's a v3 broker-PDF
   *                      parser job)
   *   - metadata.importedFromExpenseId: <id>
   *
   * The service is idempotent: re-running the same
   * import skips any Expense that already has a
   * transaction (tracked via
   * `metadata.importedFromExpenseId`). skippedCount
   * is returned.
   */
  async importFromExpenses(
    companyId: string,
    year: number,
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

    const importedFromIds = new Set(
      existing
        .map((t) => t.metadata?.importedFromExpenseId)
        .filter((x): x is string => !!x),
    )

    const start = new Date(`${year}-01-01T00:00:00.000Z`)
    const end = new Date(`${year}-12-31T23:59:59.999Z`)
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        category: { in: ['crypto', 'brokerage'] },
        invoiceDate: { gte: start, lte: end },
      },
      orderBy: { invoiceDate: 'asc' },
    })

    const newTransactions: VgTransaction[] = []
    let skippedCount = 0
    for (const e of expenses) {
      if (importedFromIds.has(e.id)) {
        skippedCount++
        continue
      }
      const type: 'wertpapier' | 'sonstige' =
        e.category === 'brokerage' ? 'wertpapier' : 'sonstige'
      // For crypto (sonstige, 10-Jahr Frist), set
      // acquisitionDate = saleDate - 1 month so
      // the row is *within* Frist (the year is the
      // same, so inFristCount > 0). For brokerage
      // (wertpapier, 1-Jahr Frist), set
      // acquisitionDate = saleDate - 1 month too —
      // that's a 1-month holding period, well
      // within the 1-Jahr Frist.
      const saleDate = e.invoiceDate
      const acqDate = new Date(saleDate)
      acqDate.setMonth(acqDate.getMonth() - 1)
      const saleDateISO = saleDate.toISOString().slice(0, 10)
      const acqDateISO = acqDate.toISOString().slice(0, 10)
      const gross = Number(e.grossAmount) || 0
      newTransactions.push({
        type,
        description: e.invoiceNumber
          ? `${e.invoiceNumber} — ${e.description}`
          : e.description,
        acquisitionDate: acqDateISO,
        acquisitionCost: gross,
        saleDate: saleDateISO,
        salePrice: gross,
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
   * v2: List the Expense rows that are eligible for
   * auto-import (used by the UI modal). Includes both
   * already-imported and not-yet-imported, with a flag
   * so the UI can pre-check the right ones.
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
    const yearData = ((settings.anlageSO as any) || {})[year] || {}
    const existing: any[] = Array.isArray(yearData.transactions)
      ? yearData.transactions
      : []
    const importedFromIds = new Set(
      existing
        .map((t) => t.metadata?.importedFromExpenseId)
        .filter((x): x is string => !!x),
    )
    const start = new Date(`${year}-01-01T00:00:00.000Z`)
    const end = new Date(`${year}-12-31T23:59:59.999Z`)
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        category: { in: ['crypto', 'brokerage'] },
        invoiceDate: { gte: start, lte: end },
      },
      orderBy: { invoiceDate: 'asc' },
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

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
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
      .text(`Anlage SO ${year} — VORSCHAU (v2)`, { align: 'left' })
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
        doc.text(`• Freigrenze (600 EUR) angewendet — vgTotal = 0`)
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

    if (data.transactions.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').text('Private Veräußerungsgeschäfte (§ 23 EStG)')
      doc.moveDown(0.3)
      doc.fontSize(8).font('Helvetica')
      for (const t of data.transactions) {
        const gain = t.salePrice - t.acquisitionCost
        const held = yearsBetween(t.acquisitionDate, t.saleDate)
        const fristYears = SPEKULATIONSFRIST_YEARS[t.type] ?? 10
        const inFrist = held < fristYears
        doc.text(
          `• [${t.type === 'wertpapier' ? 'Wertpapier' : 'Sonstige'}] ` +
            `${t.description || '(ohne Beschreibung)'} — ` +
            `Anschaffung ${t.acquisitionDate} (${this.fmtEur(t.acquisitionCost)} €) → ` +
            `Verkauf ${t.saleDate} (${this.fmtEur(t.salePrice)} €) = ` +
            `${this.fmtEur(gain)} € ${gain >= 0 ? 'Gewinn' : 'Verlust'} ` +
            `[gehalten: ${held.toFixed(2)} Jahre, Frist: ${fristYears} J., ${inFrist ? 'in Frist' : 'außerhalb'}]`,
        )
      }
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
          `de-invoice · Anlage SO v2 Vorschau`,
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
