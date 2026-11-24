import { BadRequestException } from '@nestjs/common'

/**
 * Tier 527 — an IBAN that is entered is a valid one (ISO 13616, MOD 97-10).
 *
 * Measured before: the company's own IBAN took "DE00 1234" and a German IBAN
 * with a wrong check digit. It is printed on every invoice, goes into the
 * GiroCode, the XRechnung / ZUGFeRD payment means and the SEPA files — a
 * customer's transfer to it bounces, and nobody is told why.
 */
export function ibanProblem(iban: string | null | undefined): string | null {
  const s = String(iban ?? '').replace(/\s+/g, '').toUpperCase()
  if (!s) return null
  if (s.length < 15 || s.length > 34 || !/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(s)) {
    return `Die IBAN ${iban} ist ungültig (Format).`
  }
  if (s.startsWith('DE') && s.length !== 22) {
    return `Die IBAN ${iban} ist ungültig — eine deutsche IBAN hat 22 Stellen.`
  }
  const rearranged = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of rearranged) {
    const digits = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97
  }
  return rem === 1 ? null : `Die IBAN ${iban} ist ungültig (Prüfziffer) — bitte auf Tippfehler prüfen.`
}

export function assertIban(iban: string | null | undefined): void {
  const problem = ibanProblem(iban)
  if (problem) throw new BadRequestException(problem)
}

/**
 * Tier 984 — a German account given as BLZ/Kontonummer (MT940 `:25:` of
 * Sparkassen and Volksbanken, e.g. `37040044/0532013000`, a currency code may
 * follow) as its IBAN: DE, check digits (MOD 97-10), BLZ, Kontonummer to ten
 * digits. Null for anything else.
 */
export function germanIbanOf(account: string | null | undefined): string | null {
  const m = String(account ?? '').replace(/\s+/g, '').toUpperCase().match(/^(\d{8})\/(\d{1,10})(?:[A-Z]{3})?$/)
  if (!m) return null
  const bban = m[1] + m[2].padStart(10, '0')
  let rem = 0
  for (const d of bban + '131400') rem = (rem * 10 + Number(d)) % 97 // D = 13, E = 14, check digits 00
  return `DE${String(98 - rem).padStart(2, '0')}${bban}`
}

/**
 * Tier 984 — the forms one account may be stored under: its IBAN and, for a
 * German one, BLZ/Kontonummer (with and without leading zeros) as statements
 * imported before were kept.
 */
export function accountForms(account: string): string[] {
  const raw = account.replace(/\s+/g, '').toUpperCase()
  const iban = germanIbanOf(raw) ?? raw
  const forms = new Set([account, raw, iban])
  if (/^DE\d{20}$/.test(iban)) {
    const blz = iban.slice(4, 12)
    const kto = iban.slice(12)
    forms.add(`${blz}/${kto}`)
    forms.add(`${blz}/${kto.replace(/^0+/, '')}`)
  }
  return [...forms]
}
