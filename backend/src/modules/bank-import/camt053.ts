/**
 * CAMT.053 bank-to-customer statement (ISO 20022), as banks deliver it:
 *
 *   <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
 *     <BkToCstmrStmt>
 *       <Stmt>
 *         <FrToDt><FrDtTm>2026-09-01T00:00:00+02:00</FrDtTm><ToDtTm>…</ToDtTm></FrToDt>
 *         <Acct><Id><IBAN>DE…</IBAN></Id><Ccy>EUR</Ccy>
 *               <Svcr><FinInstnId><BIC>…</BIC><Nm>Bank</Nm></FinInstnId></Svcr></Acct>
 *         <Bal><Tp><CdOrPrtry><Cd>PRCD</Cd></CdOrPrtry></Tp>
 *              <Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-08-31</Dt></Dt></Bal>
 *         <Bal>… <Cd>CLBD</Cd> …</Bal>
 *         <Ntry>
 *           <Amt Ccy="EUR">1190.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts>
 *           <BookgDt><Dt>2026-09-15</Dt></BookgDt><ValDt><Dt>2026-09-15</Dt></ValDt>
 *           <NtryDtls><TxDtls>
 *             <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
 *             <RltdPties><Dbtr><Nm>Kunde GmbH</Nm></Dbtr><DbtrAcct><Id><IBAN>DE…</IBAN></Id></DbtrAcct>
 *                        <Cdtr>…</Cdtr><CdtrAcct>…</CdtrAcct></RltdPties>
 *             <RmtInf><Ustrd>Rechnung INV-2026-000042</Ustrd></RmtInf>
 *           </TxDtls></NtryDtls>
 *         </Ntry>
 *       </Stmt>
 *     </BkToCstmrStmt>
 *   </Document>
 *
 * Tier 642: until then this parser read a format of its own — `<Bal
 * type="CLBD">`, `<Amt>` without its currency attribute, `<Ccy>` as an
 * element, the parties inside `<CdtTrxTxInf>` — which is what the specs wrote
 * and no bank does. A file from a bank came out as a statement without
 * balances and without a single transaction (`<Amt Ccy="EUR">` did not match
 * `<Amt>`). Both are read now; the old one stays for the files already made.
 *
 * String scanning instead of an XML library: the format is machine-written
 * and the handful of elements needed are unambiguous by name.
 */

import type { ParsedStatement, ParsedTransaction } from './parsers'

/** The content of the first `<tag …>…</tag>`, whatever its attributes. */
function getTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))
  return m ? m[1].trim() : null
}

function getAllTags(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out
}

/** `<tag … name="value" …>` of the first such tag. */
function getAttr(xml: string, tag: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${tag}\\s[^>]*\\b${name}="([^"]*)"`))
  return m ? m[1] : null
}

const text = (raw: string | null): string | undefined => {
  if (!raw) return undefined
  const t = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return t || undefined
}

function parseAmount(raw: string | null): number | null {
  if (!raw) return null
  const n = Number(raw.trim().replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** The calendar day of an ISO date or date-time, as written (no shift by its offset). */
function parseDate(raw: string | null): Date | null {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return Number.isFinite(d.getTime()) ? d : null
}

/** `<X><Dt>2026-09-15</Dt></X>`, `<X><DtTm>…</DtTm></X>` or the old `<Dt>2026-09-15</Dt>` directly. */
const dateIn = (block: string | null): Date | null =>
  block ? parseDate(getTag(block, 'Dt') ?? getTag(block, 'DtTm') ?? block) : null

/** `<Dbtr><Nm>…` or, from version 08 on, `<Dbtr><Pty><Nm>…`. */
const partyName = (block: string | null): string | undefined => (block ? text(getTag(block, 'Nm')) : undefined)

const iban = (block: string | null): string | undefined =>
  block ? (getTag(block, 'IBAN') || undefined)?.replace(/\s/g, '') : undefined

export function parseCamt053(input: string): ParsedStatement[] {
  // Namespace prefixes (<ns2:Stmt>) are legal and mean nothing here.
  const xml = input.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1')
  const statements: ParsedStatement[] = []

  for (const stmt of getAllTags(xml, 'Stmt')) {
    // What comes before the first entry: the account and the balances.
    const head = stmt.split(/<Ntry[\s>]/)[0]
    const acct = getTag(head, 'Acct') || ''
    const accountIban = iban(getTag(acct, 'Id') || acct)
    const bankName = text(getTag(getTag(acct, 'Svcr') || '', 'Nm'))
    let currency = getTag(acct, 'Ccy') || 'EUR'

    let openingBalance: number | undefined
    let closingBalance: number | undefined
    let openingDate: Date | undefined
    let closingDate: Date | undefined
    const balRe = /<Bal(\s[^>]*)?>([\s\S]*?)<\/Bal>/g
    let bm: RegExpExecArray | null
    while ((bm = balRe.exec(head)) !== null) {
      const inner = bm[2]
      // the type: <Tp><CdOrPrtry><Cd>, or the attribute of the old files
      const type = getTag(getTag(inner, 'Tp') || '', 'Cd') || (bm[1] || '').match(/type="([^"]+)"/)?.[1] || ''
      const amount = parseAmount(getTag(inner, 'Amt'))
      if (amount === null) continue
      const signed = getTag(inner, 'CdtDbtInd') === 'DBIT' ? -amount : amount
      // <Dt><Dt>…</Dt></Dt> — the outer one is the first match
      const date = dateIn(getTag(inner, 'Dt')) || undefined
      currency = getAttr(inner, 'Amt', 'Ccy') || getTag(inner, 'Ccy') || currency
      // OPBD: opening booked. PRCD: the previous statement's closing balance —
      // what German banks send as the opening one.
      if (type === 'OPBD' || (type === 'PRCD' && openingBalance === undefined)) {
        openingBalance = signed
        openingDate = date
      }
      if (type === 'CLBD') {
        closingBalance = signed
        closingDate = date
      }
    }

    const period = getTag(head, 'FrToDt') || ''
    const periodFrom = dateIn(getTag(period, 'FrDtTm') ?? getTag(period, 'FrDt')) || openingDate
    const periodTo = dateIn(getTag(period, 'ToDtTm') ?? getTag(period, 'ToDt')) || closingDate

    const transactions: ParsedTransaction[] = []
    for (const ntry of getAllTags(stmt, 'Ntry')) {
      const entryHead = ntry.split(/<NtryDtls[\s>]/)[0]
      const entryAmount = parseAmount(getTag(entryHead, 'Amt'))
      if (entryAmount === null) continue
      // <Sts>BOOK</Sts>, from version 08 on <Sts><Cd>BOOK</Cd></Sts>; a pending
      // entry is not booked and comes again when it is.
      const status = text(getTag(entryHead, 'Sts'))
      if (status === 'PDNG' || status === 'INFO') continue
      const ccy = getAttr(entryHead, 'Amt', 'Ccy') || getTag(entryHead, 'Ccy') || currency
      const credit = getTag(entryHead, 'CdtDbtInd') !== 'DBIT'
      const entryDate = dateIn(getTag(ntry, 'BookgDt')) || undefined
      const valueDate = dateIn(getTag(ntry, 'ValDt')) || entryDate
      if (!valueDate) continue

      // One entry can book several payments (a batch): each <TxDtls> with an
      // amount of its own is a transaction; otherwise the entry is one.
      const details = getAllTags(ntry, 'TxDtls')
      const amountOf = (tx: string): number | null =>
        parseAmount(getTag(getTag(getTag(tx, 'AmtDtls') || '', 'TxAmt') || '', 'Amt')) ?? parseAmount(getTag(tx.split(/<AmtDtls[\s>]/)[0], 'Amt'))
      const parts = details.length > 1 && details.every((tx) => amountOf(tx) !== null)
        && Math.abs(details.reduce((sum, tx) => sum + (amountOf(tx) as number), 0) - entryAmount) < 0.005
        ? details.map((tx) => ({ tx, amount: amountOf(tx) as number }))
        : [{ tx: details[0] || ntry, amount: entryAmount }]

      for (const { tx, amount } of parts) {
        const rmt = getTag(tx, 'RmtInf') || ''
        // every unstructured line, then a structured creditor reference; the
        // bank's booking text when the payer wrote nothing
        const purpose =
          text([...getAllTags(rmt, 'Ustrd'), getTag(getTag(rmt, 'CdtrRefInf') || '', 'Ref') || ''].join(' '))
          || text(getTag(rmt, 'Strd'))
          || text(getTag(ntry, 'AddtlNtryInf'))

        // The other side: who paid us (Dbtr) for a credit, whom we paid (Cdtr)
        // for a debit. In the old files they stood in <CdtTrxTxInf> / <DbtTrxTxInf>.
        const parties = getTag(tx, 'RltdPties') || getTag(tx, 'CdtTrxTxInf') || getTag(tx, 'DbtTrxTxInf') || ''
        const who = credit ? 'Dbtr' : 'Cdtr'
        const counterpartyName = partyName(getTag(parties, who)) ?? (getTag(parties, 'Dbtr') || getTag(parties, 'Cdtr') ? undefined : partyName(parties))
        const counterpartyIban = iban(getTag(parties, `${who}Acct`)) ?? iban(getTag(parties, 'Acct'))

        const ref = getTag(getTag(tx, 'Refs') || getTag(tx, 'PmtId') || '', 'EndToEndId')
        const endToEndId = ref && ref.trim().toUpperCase() !== 'NOTPROVIDED' ? ref.trim() : undefined

        transactions.push({
          valueDate,
          entryDate,
          amount: credit ? amount : -amount,
          currency: ccy,
          counterpartyName,
          counterpartyIban,
          purpose,
          endToEndId,
        })
      }
    }

    statements.push({
      format: 'camt053',
      accountIban,
      bankName,
      periodFrom: periodFrom || undefined,
      periodTo: periodTo || undefined,
      openingBalance,
      closingBalance,
      currency,
      transactions,
    })
  }
  return statements
}

/** Auto-detect format from the first non-blank line. */
export function detectFormat(text: string): 'mt940' | 'camt053' {
  // a byte-order mark is not part of the text
  const trimmed = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim()
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) return 'camt053'
  if (trimmed.includes(':20:') || trimmed.includes(':60F:') || trimmed.includes(':25:')) return 'mt940'
  // Fallback to MT940 — error path will be on the parser
  return 'mt940'
}
