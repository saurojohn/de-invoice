import { BadRequestException } from '@nestjs/common'
import { expenseAmountsError } from './amounts'

/**
 * Tier 581 — an expense with more than one VAT rate.
 *
 * An invoice with 19 % and 7 % used to be entered as two expenses (the same
 * supplier and number twice), because an Expense has one rate. Now it is one
 * expense with `taxLines`. The rule that keeps every existing row and reader
 * valid:
 *
 *   - no rows  → the expense's own netAmount / vatRate / vatAmount are its one
 *     line (every expense from before, and every one-rate expense since);
 *   - rows     → at least two, one per rate; the expense's netAmount,
 *     vatAmount and grossAmount are their sums, its vatRate the rate of the
 *     largest line (what a list shows).
 *
 * Whoever needs the split by rate (UStVA, DATEV, the bank booking) reads it
 * through `expenseTaxLines`; whoever needs the totals keeps reading the
 * expense.
 */
export interface TaxLine {
  /** as a fraction: 0.19 */
  rate: number
  net: number
  vat: number
}

type StoredLine = { vatRate: unknown; netAmount: unknown; vatAmount: unknown; position?: number | null }

/** The VAT lines of an expense — its rows, or itself as the one line. Signed as stored. */
export function expenseTaxLines(exp: {
  vatRate: unknown
  netAmount: unknown
  vatAmount: unknown
  taxLines?: StoredLine[] | null
}): TaxLine[] {
  const rows = exp.taxLines ?? []
  if (rows.length === 0) return [{ rate: Number(exp.vatRate), net: Number(exp.netAmount), vat: Number(exp.vatAmount) }]
  return [...rows]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((l) => ({ rate: Number(l.vatRate), net: Number(l.netAmount), vat: Number(l.vatAmount) }))
}

const cents = (n: number) => Math.round(n * 100)
const r4 = (n: number) => Math.round(n * 10000) / 10000

export interface CheckedTaxLines {
  /** rows to store — empty when the input is one rate after all */
  rows: { position: number; vatRate: number; netAmount: string; vatAmount: string }[]
  net: number
  vat: number
  gross: number
  /** the expense's vatRate */
  rate: number
}

/**
 * Check lines given on create / update (amounts entered positive) and turn
 * them into what is stored. `creditNote` stores them negative, like the
 * expense itself (credit-note.ts). `given` are the totals the caller sent
 * alongside, if any — they must be the sums.
 */
export function checkTaxLines(
  input: unknown,
  creditNote: boolean,
  given: { net?: number | null; vat?: number | null; gross?: number | null } = {},
): CheckedTaxLines {
  if (!Array.isArray(input) || input.length === 0) throw new BadRequestException('taxLines muss eine Liste von Steuerzeilen sein.')
  if (input.length > 8) throw new BadRequestException('Höchstens 8 Steuerzeilen je Ausgabe.')
  const seen = new Set<number>()
  const lines: TaxLine[] = []
  for (const raw of input as Record<string, unknown>[]) {
    const rate = Number(raw?.vatRate)
    const net = Number(raw?.netAmount)
    const vat = Number(raw?.vatAmount ?? NaN)
    if (![rate, net, vat].every(Number.isFinite) || rate < 0 || rate > 1 || net < 0 || vat < 0) {
      throw new BadRequestException('Jede Steuerzeile braucht vatRate (0–1), netAmount und vatAmount (nicht negativ).')
    }
    const key = Math.round(rate * 10000)
    if (seen.has(key)) throw new BadRequestException(`Der Steuersatz ${key / 100} % kommt in den Steuerzeilen mehrfach vor.`)
    seen.add(key)
    const problem = expenseAmountsError({ net, vat, gross: net + vat, rate })
    if (problem) throw new BadRequestException(problem)
    lines.push({ rate: r4(rate), net, vat })
  }
  const net = lines.reduce((s, l) => s + cents(l.net), 0) / 100
  const vat = lines.reduce((s, l) => s + cents(l.vat), 0) / 100
  const gross = (cents(net) + cents(vat)) / 100
  const eur = (n: number) => n.toFixed(2).replace('.', ',')
  for (const [label, sum, sent] of [['Netto', net, given.net], ['Umsatzsteuer', vat, given.vat], ['Brutto', gross, given.gross]] as const) {
    if (sent != null && Number.isFinite(Number(sent)) && Math.abs(cents(Math.abs(Number(sent))) - cents(sum)) > 1) {
      throw new BadRequestException(`${label} (${eur(Math.abs(Number(sent)))} €) ist nicht die Summe der Steuerzeilen (${eur(sum)} €).`)
    }
  }
  const sign = creditNote ? -1 : 1
  const main = [...lines].sort((a, b) => b.net - a.net)[0]
  return {
    rows:
      lines.length < 2
        ? []
        : lines.map((l, position) => ({
            position,
            vatRate: l.rate,
            netAmount: (sign * l.net).toFixed(4),
            vatAmount: (sign * l.vat).toFixed(4),
          })),
    net: sign * net || 0,
    vat: sign * vat || 0,
    gross: sign * gross || 0,
    rate: main.rate,
  }
}

/** For a reader: the rows as plain numbers, magnitudes as entered. */
export function taxLinesForResponse<T extends { taxLines?: StoredLine[] | null }>(exp: T) {
  return (exp.taxLines ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((l) => ({ vatRate: Number(l.vatRate), netAmount: Number(l.netAmount), vatAmount: Number(l.vatAmount) }))
}
