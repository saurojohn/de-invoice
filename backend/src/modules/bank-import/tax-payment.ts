/**
 * Tier 808 — a tax payment recognised in a bank statement.
 *
 * A debit to the Finanzamt or to the municipality was booked like any other
 * expense (a voucher on 4900 that no report reads), and what the dashboard
 * needs to call a deadline paid — the UStVA's payment, a UstPayment, an
 * expense „Gewerbesteuer" — had to be entered by hand besides. This reads a
 * transaction's counterparty and purpose and names the tax and its period;
 * the bank page then books it where the reports read it
 * (bank-import.service.ts bookTaxPayment).
 *
 * Pure: the text in, a guess out. What is matched:
 *  - who: a Finanzamt / Finanzkasse / Landes(haupt)kasse — or, for the
 *    Gewerbesteuer, a Stadt / Gemeinde / Stadtkasse / Steueramt;
 *  - what: the words a Finanzamt or a Kasse writes — USt / Umsatzsteuer
 *    (only from a Finanzamt: „inkl. 19 % USt" in a supplier's text is no
 *    tax payment), Sondervorauszahlung, Umsatzsteuer <year> /
 *    Jahreserklärung, Körperschaftsteuer / KSt / Soli, Gewerbesteuer;
 *  - when: „10/2026", „10.26", „Okt 2026", „Q4 2026", „4. Quartal 2026",
 *    „IV/2026", „4. Vj. 2026", „2026 IV. Vj", the ELSTER period codes
 *    „2026 41" … „44".
 * A guess without a period is completed by the service from the amount
 * (an unpaid return of that amount, a prepayment of that amount).
 */

export type TaxPaymentKind = 'ustva' | 'svz' | 'ustja' | 'kst' | 'gewst'

export interface TaxPaymentGuess {
  kind: TaxPaymentKind
  year: number | null
  month: number | null
  quarter: number | null
}

const FINANZAMT = /(finanzamt|finanzkasse|landes(?:haupt)?kasse|oberfinanzdirektion|steuerverwaltung|\bfa\s+[a-zäöü])/i
const GEMEINDE = /(stadtkasse|gemeindekasse|stadt\s|gemeinde\s|stadtverwaltung|steueramt|k(?:ä|ae)mmerei|verbandsgemeinde|samtgemeinde|amtskasse|markt\s|landeshauptstadt|\bstadt\b|\bgemeinde\b)/i

/** Taxes paid to a Finanzamt that are no UStVA, KSt or Sondervorauszahlung. */
const OTHER_TAXES = /lohnst|kfz|kraftfahrzeug|kirchenst|einkommenst|\best\b|grundst|erbschaft|schenkung|grunderwerb|s(?:ä|ae)umnis|zinsen|versp(?:ä|ae)tung|zwangsgeld|vollstreck/i

const MONTH_NAMES: Array<[RegExp, number]> = [
  [/\bjan(?:uar)?\b\.?/i, 1], [/\bfeb(?:ruar)?\b\.?/i, 2], [/\bm(?:ä|ae)r(?:z)?\b\.?/i, 3], [/\bapr(?:il)?\b\.?/i, 4],
  [/\bmai\b/i, 5], [/\bjun(?:i)?\b\.?/i, 6], [/\bjul(?:i)?\b\.?/i, 7], [/\baug(?:ust)?\b\.?/i, 8],
  [/\bsep(?:t(?:ember)?)?\b\.?/i, 9], [/\bokt(?:ober)?\b\.?/i, 10], [/\bnov(?:ember)?\b\.?/i, 11], [/\bdez(?:ember)?\b\.?/i, 12],
]
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 }
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y))
const okYear = (y: number) => y >= 2000 && y <= 2100

/** The period written in a text: a month, a quarter, or a year alone. */
export function periodInText(text: string): { year: number | null; month: number | null; quarter: number | null } {
  const t = ` ${text} `
  let m: RegExpMatchArray | null
  // ELSTER period codes after a year: 2026 41 … 44 (quarters), 2026 01 … 12 (months)
  if ((m = t.match(/\b(20\d{2})\s*[/ -]?\s*(4[1-4])\b/))) return { year: Number(m[1]), month: null, quarter: Number(m[2]) - 40 }
  // quarters: Q4 2026, Q4/26, 4. Quartal 2026, 4. Vj. 2026, 4/Q 2026
  if ((m = t.match(/\bQ\s*([1-4])\s*[/.\- ]?\s*(20\d{2}|\d{2})\b/i))) return { year: fullYear(m[2]), month: null, quarter: Number(m[1]) }
  if ((m = t.match(/\b([1-4])\s*\.?\s*(?:quartal|qu\.?|vj\.?|vierteljahr|kalendervierteljahr)\s*[/.\- ]?\s*(20\d{2}|\d{2})\b/i))) {
    return { year: fullYear(m[2]), month: null, quarter: Number(m[1]) }
  }
  if ((m = t.match(/\b(IV|III|II|I)\s*[/.\- ]\s*(?:(?:quartal|qu\.?|vj\.?)\s*[/.\- ]?\s*)?(20\d{2}|\d{2})\b/))) {
    return { year: fullYear(m[2]), month: null, quarter: ROMAN[m[1]] }
  }
  // the year first: 2026 Q4, 2026/IV, 2026 IV. Vj, 2026 4. Quartal
  if ((m = t.match(/\b(20\d{2})\s*[/.\- ]?\s*Q\s*([1-4])\b/i))) return { year: Number(m[1]), month: null, quarter: Number(m[2]) }
  if ((m = t.match(/\b(20\d{2})\s*[/.\- ]?\s*(IV|III|II|I)\b\.?/))) return { year: Number(m[1]), month: null, quarter: ROMAN[m[2]] }
  if ((m = t.match(/\b(20\d{2})\s*[/.\- ]?\s*([1-4])\s*\.\s*(?:quartal|qu\.?|vj\.?|vierteljahr)/i))) return { year: Number(m[1]), month: null, quarter: Number(m[2]) }
  // months by name: Okt 2026, Oktober 26
  for (const [re, month] of MONTH_NAMES) {
    const named = t.match(new RegExp(`${re.source}\\s*[/.\\- ]?\\s*(20\\d{2}|\\d{2})\\b`, 'i'))
    if (named && okYear(fullYear(named[1]))) return { year: fullYear(named[1]), month, quarter: null }
  }
  // months by number: 10/2026, 10.26, 10-2026, 2026/10 (not a day: „10.11.2026" is a date)
  if ((m = t.match(/(?<![\d.])(0?[1-9]|1[0-2])\s*[/.-]\s*(20\d{2}|\d{2})(?![\d.]\d)/))) {
    const y = fullYear(m[2])
    if (okYear(y)) return { year: y, month: Number(m[1]), quarter: null }
  }
  if ((m = t.match(/\b(20\d{2})\s*[/-]\s*(0?[1-9]|1[0-2])\b(?![\d.])/))) return { year: Number(m[1]), month: Number(m[2]), quarter: null }
  // a year alone
  if ((m = t.match(/\b(20\d{2})\b/))) return { year: Number(m[1]), month: null, quarter: null }
  return { year: null, month: null, quarter: null }
}

export function guessTaxPayment(txn: { counterpartyName?: string | null; purpose?: string | null }): TaxPaymentGuess | null {
  const name = String(txn.counterpartyName || '')
  const purpose = String(txn.purpose || '')
  const text = `${name} ${purpose}`
  const fromFinanzamt = FINANZAMT.test(name) || /finanzamt/i.test(purpose)
  const fromGemeinde = GEMEINDE.test(name)

  let kind: TaxPaymentKind | null = null
  if (/gewerbesteuer|\bgew\.?\s?st\b/i.test(text) && (fromGemeinde || /gewerbesteuer/i.test(text))) kind = 'gewst'
  else if (/k(?:ö|oe)rperschaft(?:s)?steuer/i.test(text) || (fromFinanzamt && /\bkst\b|solidarit|\bsolz\b|\bsoli\b/i.test(text))) kind = 'kst'
  else if (fromFinanzamt && /sondervorauszahlung|sonder-?\s?vz\b|\bsvz\b|ust\s*1\s*h\b|1\/11/i.test(text)) kind = 'svz'
  else if (fromFinanzamt && /umsatzsteuer\s*(?:-?\s*)?(?:jahres|erkl)|ust[-\s]?(?:ja\b|jahr|erkl)|abschlusszahlung\s*(?:ust|umsatz)/i.test(text)) kind = 'ustja'
  else if (fromFinanzamt && /\bust\b|umsatzsteuer|\bust[-\s]?va\b|\bust[-\s]?vz\b|voranmeldung/i.test(text)) kind = 'ustva'
  if (!kind) {
    // a Finanzamt debit that names no tax („Steuerzahlung StNr …"): a UStVA only
    // when its amount is that of an unpaid return (the service decides); never
    // the taxes this app does not keep
    if (fromFinanzamt && !OTHER_TAXES.test(text)) return { kind: 'ustva', year: null, month: null, quarter: null }
    return null
  }

  const p = periodInText(purpose)
  if (kind === 'svz' || kind === 'ustja') return { kind, year: p.year, month: null, quarter: null }
  // a UStVA by year alone is no period; the prepayments are quarterly
  if (kind === 'ustva') return { kind, year: p.month || p.quarter ? p.year : null, month: p.month, quarter: p.quarter }
  return { kind, year: p.quarter ? p.year : null, month: null, quarter: p.quarter }
}
