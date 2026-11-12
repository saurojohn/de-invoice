/**
 * Tier 837 — the loss carried forward (Verlustvortrag) into a profit year.
 *
 * Measured in the loss-year drill (a GmbH founded 2025 with a loss of
 * 31 000 €, a profit of 40 000 € in 2026): KSt 1 2026 taxed the full 40 000 —
 * KSt 6 000, Soli 330, GewSt 5 600 instead of 1 350 / 74,25 / 1 260 — and the
 * GuV's taxes, the Jahresüberschuss and the Bilanz's Steuerrückstellung took
 * the 9 245,75 € too much with them. The Verlustabzug (Kz 50) was a
 * placeholder that could not be filled in.
 *
 * The law:
 *  - KSt: § 8 Abs. 1 KStG with § 10d Abs. 2 EStG — a loss carried forward is
 *    deducted from the next years' income without limit up to 1 000 000 €,
 *    beyond that up to 70 % (2024–2027, § 52 Abs. 18b EStG) / 60 % of the rest
 *    (verlustProzent in kst1.service.ts).
 *  - GewSt: § 10a S. 1–2 GewStG — the same 1 000 000 €, beyond that 60 % in
 *    every year: the Wachstumschancengesetz raised only § 10d EStG, the change
 *    of § 10a GewStG was dropped from the final law. No carry-back.
 *  - The loss carried back to the year before (§ 10d Abs. 1 EStG, KSt only, on
 *    by law unless the company waives it) is not modelled: what the app carries
 *    forward is the whole loss. The figures of the Verlustfeststellungsbescheid
 *    (§ 10d Abs. 4 EStG, § 10a S. 6 GewStG) are binding — entered on the
 *    accounting page (settings.verlustvortrag[year]), they replace the app's own
 *    for that year, and the years after go on from them.
 */

/** § 10d Abs. 2 S. 1 EStG, § 10a S. 1 GewStG: deductible without limit up to this. */
export const VERLUST_SOCKEL = 1_000_000

/** § 10a S. 2 GewStG: 60 % of the Gewerbeertrag beyond the Sockel, in every year. */
export const gewstVerlustProzent = (_year: number): number => 60

const r2 = (n: number) => Math.round(n * 100) / 100

/** What of `vortrag` may be deducted from a positive result of `positiv` (pure). */
export function verlustAbzug(vortrag: number, positiv: number, prozent: number): number {
  if (!(vortrag > 0) || !(positiv > 0)) return 0
  const hoechstens = positiv <= VERLUST_SOCKEL ? positiv : VERLUST_SOCKEL + ((positiv - VERLUST_SOCKEL) * prozent) / 100
  return r2(Math.min(vortrag, hoechstens))
}

export type VerlustQuelle = 'berechnet' | 'bescheid' | 'keiner'

export interface VerlustKonto {
  /** the loss carried in, as on 31.12. of the year before */
  anfang: number
  /** where `anfang` comes from: the app's own years, the Bescheid entered, none */
  quelle: VerlustQuelle
  /** deducted this year (§ 10d Abs. 2 EStG / § 10a GewStG) */
  abzug: number
  /** this year's own loss, added */
  zugang: number
  /** carried on, as on 31.12. of the year */
  ende: number
}

/** One year of the loss account (pure): `ergebnis` is the result before the deduction. */
export function verlustKonto(anfang: number, quelle: VerlustQuelle, ergebnis: number, prozent: number): VerlustKonto {
  const a = r2(Math.max(0, anfang))
  const abzug = verlustAbzug(a, ergebnis, prozent)
  const zugang = r2(Math.max(0, -ergebnis))
  return { anfang: a, quelle, abzug, zugang, ende: r2(a - abzug + zugang) }
}

/** The Bescheid figure entered for the year (settings.verlustvortrag[year][tax]), or null. */
export function eingetragenerVortrag(settings: Record<string, any> | null | undefined, year: number, tax: 'kst' | 'gewst'): number | null {
  const v = settings?.verlustvortrag?.[year]?.[tax]
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? r2(n) : null
}

/** "31.000,00" — as the notes write an amount. */
export const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The first year the company has books in the app: the earliest invoice or
 * bill. A loss account starts there — a year before it has nothing to carry.
 */
export async function ersterBuchjahr(
  prisma: { invoice: { findFirst: (a: any) => Promise<any> }; expense: { findFirst: (a: any) => Promise<any> } },
  companyId: string,
): Promise<number | null> {
  const [inv, exp] = await Promise.all([
    prisma.invoice.findFirst({ where: { companyId, status: { not: 'draft' } }, orderBy: { issueDate: 'asc' }, select: { issueDate: true } }),
    prisma.expense.findFirst({ where: { companyId }, orderBy: { invoiceDate: 'asc' }, select: { invoiceDate: true } }),
  ])
  const years = [inv?.issueDate, exp?.invoiceDate].filter(Boolean).map((d: Date) => new Date(d).getFullYear())
  return years.length ? Math.min(...years) : null
}
