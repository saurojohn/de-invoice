/**
 * Tier 730b — a country on an address, as the PDF writes it (backend
 * common/business-letter.ts): no country line in a domestic letter, else
 * the country in German capitals (DIN 5008).
 */

/** An address's country as an ISO code ("DE"), whatever was stored ("DE", "Deutschland") */
export function countryCode(value: unknown): string {
  const v = String(value ?? "").trim()
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase()
  const names: Record<string, string> = { deutschland: "DE", germany: "DE", österreich: "AT", austria: "AT", schweiz: "CH", switzerland: "CH" }
  return names[v.toLowerCase()] ?? v.toUpperCase()
}

/** The country line of an address, in German capitals (DIN 5008): "ÖSTERREICH" */
export function countryLine(value: unknown): string {
  const code = countryCode(value)
  if (!/^[A-Z]{2}$/.test(code)) return String(value ?? "").trim().toUpperCase()
  try {
    return (new Intl.DisplayNames(["de"], { type: "region" }).of(code) || code).toUpperCase()
  } catch {
    return code
  }
}

/** Whether a letter from `from` to `to` names the countries (they differ) */
export function namesCountries(from: unknown, to: unknown): boolean {
  const a = countryCode(from || "DE")
  const b = countryCode(to || "DE")
  return a !== b
}
