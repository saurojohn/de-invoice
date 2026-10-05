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
