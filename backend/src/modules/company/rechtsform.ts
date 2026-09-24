/**
 * Tier 441 — the company's legal form.
 *
 * KSt 1 and the Berater packager read `company.rechtsform`, which did not
 * exist, and fell back to "GmbH": every company was a corporation — KSt 1 in
 * the packager, Anlage G left out. Anlage AUS looked in `settings.rechtsform`
 * and the legal name instead, and KSt 1 counted a GmbH & Co. KG (a
 * partnership) as a corporation. The GewSt Freibetrag of 24 500 € (§ 11 Abs. 1
 * Nr. 1 GewStG) went to every company, corporations included.
 *
 * Resolution: the column; else an old `settings.rechtsform`; else the suffix
 * of the legal name / name ("Muster GmbH"); else unknown (null).
 */
export const RECHTSFORMEN = [
  'Einzelunternehmen',
  'Freiberufler',
  'GbR',
  'PartG',
  'OHG',
  'KG',
  'GmbH & Co. KG',
  'GmbH',
  'UG (haftungsbeschränkt)',
  'AG',
  'KGaA',
] as const

export type Rechtsform = (typeof RECHTSFORMEN)[number]

const KAPITALGESELLSCHAFTEN: readonly string[] = ['GmbH', 'UG (haftungsbeschränkt)', 'AG', 'KGaA']

export function isKapitalgesellschaft(rechtsform: string | null | undefined): boolean {
  return !!rechtsform && KAPITALGESELLSCHAFTEN.includes(rechtsform)
}

const valid = (v: unknown): Rechtsform | null =>
  typeof v === 'string' && (RECHTSFORMEN as readonly string[]).includes(v) ? (v as Rechtsform) : null

/** The legal form a company name ends in, if it names one. */
export function rechtsformFromName(name: string | null | undefined): Rechtsform | null {
  const n = (name || '').trim()
  if (/GmbH\s*&\s*Co\.?\s*KG\b/i.test(n)) return 'GmbH & Co. KG'
  if (/\bKGaA\b/.test(n)) return 'KGaA'
  if (/\bUG\b/.test(n)) return 'UG (haftungsbeschränkt)'
  if (/\bg?GmbH\b/.test(n)) return 'GmbH'
  if (/\bAG\b/.test(n)) return 'AG'
  if (/\bOHG\b/.test(n)) return 'OHG'
  if (/\bKG\b/.test(n)) return 'KG'
  if (/\bGbR\b/.test(n)) return 'GbR'
  if (/\bPartG\b/.test(n)) return 'PartG'
  return null
}

export function resolveRechtsform(company: {
  rechtsform?: string | null
  settings?: unknown
  legalName?: string | null
  name?: string | null
}): { rechtsform: Rechtsform | null; source: 'gesetzt' | 'abgeleitet' | null } {
  const set = valid(company.rechtsform) ?? valid((company.settings as any)?.rechtsform)
  if (set) return { rechtsform: set, source: 'gesetzt' }
  const derived = rechtsformFromName(company.legalName) ?? rechtsformFromName(company.name)
  return derived ? { rechtsform: derived, source: 'abgeleitet' } : { rechtsform: null, source: null }
}
