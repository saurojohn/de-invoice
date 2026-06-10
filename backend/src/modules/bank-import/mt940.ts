/**
 * MT940 SWIFT customer statement message parser.
 *
 * MT940 is line-oriented: each line starts with a numeric
 * tag, optional sub-tags (e.g. :20:, :25:, :60F:, :61:,
 * :86:), and the value follows. Sub-fields are separated
 * by `//` (e.g. Buchungsdatum//Wertstellung within :61:).
 *
 * Key tags we care about:
 *   :20:  Transaction reference number (file-level)
 *   :25:  Account identification (IBAN / Kontonummer)
 *   :28C: Statement number / sequence
 *   :60F: Opening balance (F = final, M = intermediate)
 *   :61:  Statement line (the actual transaction)
 *   :86:  Information to account owner (purpose, counterparty)
 *   :62F: Closing balance
 *   :64:  Closing available balance (optional)
 *
 * Within :61: the sub-fields are:
 *   YYMMDD[MMDD] [2!a][4!n][3!a][N]  - date, entry date, debit/credit mark,
 *                                        funds code, amount, transaction type
 *   The amount can be suffixed with "N" for intra-day or
 *   carry an ISO currency code. We parse amount + DC mark
 *   and the second date (entry date) when present.
 *
 * The :86: field is free-form multi-line. We concatenate
 * sub-tags (?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28,
 * ?29, ?60, ?61, ?62, ?63) into a single purpose string.
 * Sub-tags use a leading `?` and are 2 digits + 1 char
 * identifier; some banks use a slightly different shape so
 * we tolerate `?20`, `?21`, etc.
 */

import type { ParsedStatement, ParsedTransaction } from './parsers'

/** Split an MT940 file into the constituent blocks
 *  (:20:...:25:...:60F:...:61:...:86:...:62F:...).
 *  Each block belongs to one statement. Some files
 *  have multiple statements in a row (multi-account). */
function splitBlocks(text: string): string[] {
  // Each statement starts with :20: — split on that,
  // discarding any SWIFT block header (e.g. the :1:
  // basic header line) that comes before the first :20:.
  const blocks: string[] = []
  const re = /(?=^:20:)/gm
  const parts = text.split(re)
  for (const p of parts) {
    // Only keep blocks that start with a real :20: tag
    if (/^:20:/.test(p.trimStart())) blocks.push(p)
  }
  return blocks
}

/** Parse a SWIFT balance tag like `EUR12345,67` or
 *  `D260606EUR12345,67` into (sign, amount). The
 *  leading D/R/C is the debit/credit mark (D = debit,
 *  R = credit, RC = reversal of credit). For balance
 *  fields, D means negative and C means positive. */
function parseBalance(raw: string): { sign: 1 | -1; amount: number; currency: string } | null {
  const m = raw.match(/^([DRC])(\d{6})?([A-Z]{3})([0-9.,]+)$/)
  if (!m) return null
  const [, mark, , currency, amountRaw] = m
  const sign: 1 | -1 = mark === 'C' ? 1 : -1
  const amount = Number(amountRaw.replace(/\./g, '').replace(',', '.'))
  if (!Number.isFinite(amount)) return null
  return { sign, amount, currency }
}

/** Parse a SWIFT date YYMMDD into a Date. Year cutoff
 *  at 70: yy < 70 = 2000s, yy >= 70 = 1900s. Matches
 *  typical MT940 conventions and matches what most
 *  German banks emit (we're well past Y2K). */
function parseSwiftDate(yymmdd: string): Date | null {
  if (!/^\d{6}$/.test(yymmdd)) return null
  const yy = parseInt(yymmdd.substring(0, 2), 10)
  const mm = parseInt(yymmdd.substring(2, 4), 10) - 1
  const dd = parseInt(yymmdd.substring(4, 6), 10)
  const year = yy < 70 ? 2000 + yy : 1900 + yy
  const d = new Date(Date.UTC(year, mm, dd))
  return Number.isFinite(d.getTime()) ? d : null
}

/** Parse :61: into (valueDate, entryDate, amount, currency).
 *  The grammar (simplified):
 *    YYMMDD[MMDD]  - valueDate + optional entryDate
 *    [RC]D?        - credit/debit/reversal mark
 *    N?            - funds code (optional, ignored)
 *    3!a           - transaction type code (ignored)
 *    15d           - amount (no thousands, comma = decimal)
 *    ([A-Z]{3})?   - ISO currency (only if statement runs
 *                     in mixed-currency mode, which is rare)
 *    N?            - "N" = intra-day reversal, ignored
 *
 *  The amount can include `,` as decimal separator. We
 *  tolerate that. */
function parseStatementLine(line: string): ParsedTransaction | null {
  // YYMMDD[MMDD] = 6 or 10 chars
  const dateMatch = line.match(/^(\d{6})(\d{4})?/)
  if (!dateMatch) return null
  const valueDate = parseSwiftDate(dateMatch[1])
  if (!valueDate) return null
  const entryDate = dateMatch[2] ? parseSwiftDate(dateMatch[2]) : undefined

  // After the date(s): a 1- or 2-char mark (R/C/RD/CD),
  // then optional funds code (1 letter), then 3-letter
  // type code, then the amount, then the customer
  // reference section starting with "//" or "NONREF".
  // The funds code and type code are not useful for
  // matching invoices — we just need the mark + amount.
  let cursor = dateMatch[0].length
  // Skip marks: e.g. "R", "C", "RD", "CD", "RC", "EC"
  const markMatch = line.substring(cursor).match(/^(RCD|RC|RD|CD|EC|ED|D|C)/)
  if (!markMatch) return null
  cursor += markMatch[0].length
  // Skip the funds code (1 letter) and the transaction
  // type code (3 letters). Some banks omit the funds
  // code (e.g. DKB uses just the 3-letter type); we
  // tolerate 0-4 letters here.
  while (cursor < line.length && /^[A-Z]$/.test(line[cursor])) {
    cursor++
  }
  // Amount: digits + optional comma-decimal + optional
  // thousand dots. We stop at the first non-digit /
  // non-comma / non-dot character.
  const amountMatch = line.substring(cursor).match(/^([0-9]+(?:[.,][0-9]+)?)/)
  if (!amountMatch) return null
  const amountStr = amountMatch[1].replace(/\./g, '').replace(',', '.')
  const amountAbs = Number(amountStr)
  if (!Number.isFinite(amountAbs)) return null
  cursor += amountMatch[0].length
  // Sign: a leading "C" or "RC" (reversal of credit)
  // means incoming (positive); "D" or "RD" means
  // outgoing (negative).
  const isCredit = markMatch[0].startsWith('C') || markMatch[0].startsWith('RC')
  const amount = (isCredit ? 1 : -1) * amountAbs
  // MT940 does NOT embed currency in :61: — the
  // currency is in the statement header (:60F:/:62F:).
  // The caller (parseMt940) patches the currency from
  // the statement's overall currency after parsing.
  return {
    valueDate,
    entryDate: entryDate || undefined,
    amount,
    currency: 'EUR',
  }
}

/** Parse the :86: block (counterparty + purpose).
 *  Sub-tags are introduced by `?NN` (2 digits). The
 *  block runs to the next top-level :tag: marker. We
 *  concatenate all sub-tag content with a single space
 *  — we don't preserve the sub-tag structure because
 *  different banks use different conventions and the
 *  fuzzy match just needs the raw text. */
function parseInfoToAccountOwner(block: string): { name?: string; iban?: string; purpose?: string } {
  // Sub-tags are inside the :86: content. We split on
  // the 3-letter CR-LF-chunk pattern. The most reliable
  // way is to grab every 2-digit `?NN` segment.
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const name: string[] = []
  const iban: string[] = []
  const purpose: string[] = []
  for (const line of lines) {
    // IBAN pattern
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{12,30}$/.test(line.replace(/\s+/g, ''))) {
      iban.push(line.replace(/\s+/g, ''))
      continue
    }
    // Sub-tag with leading 2 digits
    const subMatch = line.match(/^(\d{2})(.+)$/)
    if (subMatch) {
      // :20, :21, :22 etc — most banks use these for
      // Buchungstext. We put them all into "purpose" so
      // the matching logic can find the invoice number.
      purpose.push(subMatch[2])
    } else {
      name.push(line)
    }
  }
  return {
    name: name.length ? name.join(' / ').slice(0, 200) : undefined,
    iban: iban.length ? iban[0] : undefined,
    purpose: purpose.length ? purpose.join(' ').slice(0, 500) : undefined,
  }
}

export function parseMt940(text: string): ParsedStatement[] {
  const statements: ParsedStatement[] = []
  const blocks = splitBlocks(text)

  for (const block of blocks) {
    let accountIban: string | undefined
    let bankName: string | undefined
    let openingBalance: number | undefined
    let closingBalance: number | undefined
    let currency = 'EUR'
    const transactions: ParsedTransaction[] = []

    // Split the block on the top-level :NN: tags. The
    // regex captures the tag number as a group; m[0] is
    // the full ":NN:" token whose length we use to skip
    // past it.
    const tagRe = /:(\d{2}[A-Z]?):/g
    const tags: { tag: string; value: string; index: number }[] = []
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(block)) !== null) {
      tags.push({ tag: m[1], value: '', index: m.index })
    }
    // Compute value (the slice between this tag's end and the next tag's start)
    for (let i = 0; i < tags.length; i++) {
      // m[0] is the full ":20:" or ":60F:" token. Its
      // length (4 for :20:, 5 for :60F:) tells us where
      // the value starts. We re-run the regex match to
      // get the exact match length without relying on
      // tag-name length.
      const matchLength = block.substring(tags[i].index).match(/:(\d{2}[A-Z]?):/)![0].length
      const start = tags[i].index + matchLength
      const end = i + 1 < tags.length ? tags[i + 1].index : block.length
      tags[i].value = block.substring(start, end).trim()
    }

    // Index by tag for easy lookup
    const byTag = new Map<string, string[]>()
    for (const t of tags) {
      if (!byTag.has(t.tag)) byTag.set(t.tag, [])
      byTag.get(t.tag)!.push(t.value)
    }

    // :25: — account identification. The line after is
    // also a bank identifier (optionally). Bank code can
    // be on its own line, separated by a newline.
    const acc25 = (byTag.get('25') || [])[0]
    if (acc25) {
      // Strip a leading 4!a bank code if present
      accountIban = acc25.replace(/^[A-Z]{4}/, '').replace(/\s+/g, '')
      // Some banks have the bank name on the next line —
      // we don't use it for matching, skip.
    }

    // :60F: opening balance. Tag may repeat per
    // statement (intermediate statements have :60M:).
    const ob = (byTag.get('60F') || byTag.get('60M') || [])[0]
    if (ob) {
      const b = parseBalance(ob)
      if (b) {
        openingBalance = b.sign * b.amount
        currency = b.currency
      }
    }

    // :62F: closing balance. Some banks (and many
    // editors) append a trailing `-` SWIFT terminator
    // inside the same line — strip it before parsing.
    const cbRaw = (byTag.get('62F') || byTag.get('62M') || [])[0]
    if (cbRaw) {
      const cbClean = cbRaw.replace(/-$/, '').trim()
      const b = parseBalance(cbClean)
      if (b) {
        closingBalance = b.sign * b.amount
        if (!currency) currency = b.currency
      }
    }

    // Walk :61: + matching :86: in order. The :86: block
    // belongs to the most recent :61: until the next :61:
    // or :62F:.
    const tagList = tags.filter((t) => t.tag === '61' || t.tag === '86' || t.tag === '62F' || t.tag === '62M')
    let currentTxn: ParsedTransaction | null = null
    for (const t of tagList) {
      if (t.tag === '61') {
        // Finalise the previous one
        if (currentTxn) transactions.push(currentTxn)
        const txn = parseStatementLine(t.value)
        currentTxn = txn
      } else if (t.tag === '86' && currentTxn) {
        const info = parseInfoToAccountOwner(t.value)
        if (info.name) currentTxn.counterpartyName = info.name
        if (info.iban) currentTxn.counterpartyIban = info.iban
        if (info.purpose) currentTxn.purpose = info.purpose
      } else if (t.tag === '62F' || t.tag === '62M') {
        // End of statement — finalise
        if (currentTxn) transactions.push(currentTxn)
        currentTxn = null
      }
    }
    if (currentTxn) transactions.push(currentTxn)

    statements.push({
      format: 'mt940',
      accountIban,
      bankName,
      openingBalance,
      closingBalance,
      currency,
      transactions: transactions.map((t) => ({ ...t, currency })),
    })
  }
  return statements
}
