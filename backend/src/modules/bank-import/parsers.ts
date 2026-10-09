/**
 * Bank statement parsers — MT940 (SWIFT) + CAMT.053 (SEPA XML).
 *
 * Both formats are widely used in German banking:
 *   - MT940: older SWIFT proprietary format, still default
 *     export for many banks (Sparkasse, Volksbank, etc).
 *     Plain text with `:`-prefixed tags.
 *   - CAMT.053: SEPA XML standard, increasingly common,
 *     pushed by ECB for PSD2 / PSD3 compliance. Structured
 *     XML with namespaces.
 *
 * We deliberately do not pull in a library (no `mt940`, no
 * `camt053`, no `xml2js`) — these formats are small enough
 * that a focused parser is more debuggable than a third-
 * party module that breaks on edge cases. Both parsers
 * return a uniform `ParsedStatement` shape so the rest of
 * the service can treat them identically.
 */

export interface ParsedStatement {
  format: 'mt940' | 'camt053'
  accountIban?: string
  bankName?: string
  periodFrom?: Date
  periodTo?: Date
  openingBalance?: number
  closingBalance?: number
  currency: string
  transactions: ParsedTransaction[]
}

export interface ParsedTransaction {
  valueDate: Date
  entryDate?: Date
  /** Positive = incoming (Gutschrift), negative = outgoing (Lastschrift). */
  amount: number
  currency: string
  counterpartyName?: string
  counterpartyIban?: string
  purpose?: string
  endToEndId?: string
}

/**
 * Tier 642 — one statement per account.
 *
 * A bank's file has a block per booking day (MT940: one `:20:` each; CAMT:
 * one `<Stmt>` each), and the import took the first block and dropped the
 * rest without a word — of a month's download, the first day. The blocks of
 * one account are one statement: the first opening balance, the last closing
 * balance, every transaction, the period from the first day to the last.
 */
export function mergeByAccount(parsed: ParsedStatement[]): ParsedStatement[] {
  const byAccount = new Map<string, ParsedStatement[]>()
  for (const s of parsed) {
    const key = (s.accountIban || '').replace(/\s/g, '').toUpperCase()
    byAccount.set(key, [...(byAccount.get(key) ?? []), s])
  }
  const time = (d?: Date) => (d ? new Date(d).getTime() : undefined)
  const firstDay = (s: ParsedStatement) =>
    time(s.periodFrom) ?? time(s.periodTo) ?? Math.min(...s.transactions.map((t) => new Date(t.valueDate).getTime()), Number.MAX_SAFE_INTEGER)
  return [...byAccount.values()].map((list) => {
    if (list.length === 1) return list[0]
    // in the order of the days they cover; blocks of the same day stay as they came
    const ordered = list.map((s, i) => ({ s, i })).sort((a, b) => firstDay(a.s) - firstDay(b.s) || a.i - b.i).map((x) => x.s)
    const days = ordered.flatMap((s) => [time(s.periodFrom), time(s.periodTo)]).filter((t): t is number => t !== undefined)
    return {
      ...ordered[0],
      bankName: ordered.find((s) => s.bankName)?.bankName,
      periodFrom: days.length ? new Date(Math.min(...days)) : undefined,
      periodTo: days.length ? new Date(Math.max(...days)) : undefined,
      openingBalance: ordered.find((s) => s.openingBalance !== undefined)?.openingBalance,
      closingBalance: [...ordered].reverse().find((s) => s.closingBalance !== undefined)?.closingBalance,
      transactions: ordered.flatMap((s) => s.transactions),
    }
  })
}
