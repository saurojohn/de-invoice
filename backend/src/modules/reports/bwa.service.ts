import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { AssetsService } from '../assets/assets.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 86 + 93: BWA (Betriebswirtschaftliche
 * Auswertung).
 *
 * The monthly operating report that a
 * Steuerberater sends to the Mandant. The
 * canonical DATEV BWA structure (4-digit
 * bucket codes 1000-5999) with:
 *   - Monatswert (current month)
 *   - Vormonat (previous month)
 *   - YTD (Jan - selected month)
 *   - Vorjahres-YTD (Jan - same month prior year)
 *   - % change (YTD vs Vorjahres-YTD)
 *
 * v1 sources the BWA from the same data as
 * the P&L (tier 75) + the G+V (tier 82) +
 * the AfA from the Anlagenverzeichnis (tier
 * 83). No new data — just a different view
 * of the same numbers, in the format the
 * Mandant is used to from the Berater.
 *
 * Tier 93: BWA granularity extended. The
 * "3600 Sonstige betriebliche Aufw."
 * catchall is split into:
 *   3200  Raumkosten
 *   3300  Versicherungen
 *   3400  Werbung / Reise
 *   3500  Instandhaltung
 * (the canonical DATEV BWA structure). Plus:
 *   4100  Zinserträge             (Finanzergebnis)
 *   5000  Steuern vom Einkommen   (GewSt, KSt, ESt)
 *   5100  Sonstige Steuern        (Grundsteuer, Kfz-Steuer)
 *
 * The matchers reuse the same category
 * keywords as Anlage S / Anlage V so the
 * user's existing categorization carries
 * over to the BWA. The catchall 3600
 * shrinks accordingly.
 *
 * DATEV BWA bucket mapping (4-digit codes):
 *
 *   REVENUE (Erlöse):
 *     1000  Umsatzerlöse                (Invoice netTotal)
 *     1300  Sonstige betriebliche Erträge (CustomerCredit)
 *
 *   OPERATING COST (Betriebliche Aufwendungen):
 *     2000  Materialaufwand             (Material/Waren)
 *     3000  Personalkosten              (Personal/Lohn/Gehalt)
 *     3100  Abschreibungen               (AfA)
 *     3200  Raumkosten                   (Miete/Heizung/Nebenkosten)  [tier 93]
 *     3300  Versicherungen               (Versicherung/Beitrag)        [tier 93]
 *     3400  Werbung / Reise              (Werbung/Marketing/Reise)    [tier 93]
 *     3500  Instandhaltung               (Reparatur/Wartung)           [tier 93]
 *     3600  Sonstige betriebl. Aufw.    (catchall)
 *
 *   FINANZERGEBNIS:
 *     4100  Zinserträge                 (0 in v1 — no data model)     [tier 93]
 *     4200  Zinsaufwendungen            (Schuldzins/Zins/Darlehen)
 *
 *   STEUERN:
 *     5000  Steuern vom Einkommen       (GewSt/KSt/ESt)               [tier 93]
 *     5100  Sonstige Steuern            (Grundsteuer/Kfz-Steuer)      [tier 93]
 *
 *   NOT COMPUTED (nicht ausgewiesen):
 *     1100  Bestandsveränderungen
 *     1200  Aktivierte Eigenleistungen
 *     4400  Beteiligungserträge
 *     4500  Beteiligungs-Abschreibungen
 *
 * v2 work (not in scope):
 *   - Per-Expense BWA-Bucket override field
 *     (today: reuses Anlage S / EÜR
 *     matchers)
 *   - DATEV BWA export (.bwa XML format
 *     for DATEV Kassenbuch / Rechnungswesen
 *     import)
 */
export interface BwaLine {
  bucket: string
  label: string
  monat: number          // current month value
  vormonat: number       // previous month value
  ytd: number            // Jan - selected month
  vorjahresYtd: number   // Jan - same month prior year
  ytdChangePct: number   // (ytd - vorjahresYtd) / abs(vorjahresYtd) * 100
}

export interface BwaResult {
  year: number
  month: number            // 1-12
  vorjahr: number          // year - 1
  company: { name: string; legalName: string | null }
  lines: BwaLine[]
  totals: {
    erloeseMonat: number
    erloeseVormonat: number
    erloeseYtd: number
    erloeseVorjahresYtd: number
    materialaufwandMonat: number
    personalaufwandMonat: number
    abschreibungenMonat: number
    sonstigeMonat: number
    betriebsergebnisMonat: number
    betriebsergebnisYtd: number
    betriebsergebnisVorjahresYtd: number
    // Tier 93: the new BWA lines also surface
    // in the totals so the Berater can see the
    // subtotals at a glance:
    //   - finanzergebnisMonat = 4100 - 4200
    //   - steuernMonat        = 5000 + 5100
    //   - jahresergebnisMonat = betriebsergebnis
    //                            + finanzergebnis
    //                            - steuern
    finanzergebnisMonat: number
    finanzergebnisYtd: number
    finanzergebnisVorjahresYtd: number
    steuernMonat: number
    steuernYtd: number
    steuernVorjahresYtd: number
    jahresergebnisMonat: number
    jahresergebnisYtd: number
    jahresergebnisVorjahresYtd: number
  }
  counts: { invoices: number; expenses: number; assets: number; afaBookings: number }
  // Tier 87: 'booked' = the 3100 line uses real
  // Expense rows (AfA-buchen was clicked for this
  // year). 'computed' = the 3100 line uses the
  // in-memory Asset pool. Same value the UI shows
  // in the "AfA-Status" badge.
  afaSource: 'booked' | 'computed'
  generatedAt: string
  disclaimer: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Tier 93: category-to-bucket matchers. The
// catchall 3600 is the negation of all the
// others. The matchers are evaluated in
// order; the FIRST match wins. 4100 (Zins-
// erträge) is in the table but returns 0
// in v1 because the schema has no
// Zinsertrag model.
const BWA_BUCKET_MATCHERS: Array<{ bucket: string; test: (cat: string) => boolean }> = [
  { bucket: '2000', test: (c) => /^(Material|Waren|Rohstoffe?|Fremdleistung)/i.test(c) },
  { bucket: '3000', test: (c) => /^(Personal|Lohn|Gehalt|SV)/i.test(c) },
  { bucket: '3100', test: () => false }, // signal from booked AfA, not from category
  { bucket: '3200', test: (c) => /^(Miete|Raum|Heizung|Nebenkosten|Pacht)/i.test(c) },
  { bucket: '3300', test: (c) => /^(Versicherung|Beitrag)/i.test(c) },
  { bucket: '3400', test: (c) => /^(Werbung|Marketing|Reise|Bewirtung)/i.test(c) },
  { bucket: '3500', test: (c) => /^(Reparatur|Instandhaltung|Wartung)/i.test(c) },
  { bucket: '4200', test: (c) => /^(Schuldzins|Zins|Darlehen)/i.test(c) },
  { bucket: '5000', test: (c) => /^(Gewerbesteuer|Körperschaftsteuer|Einkommensteuer|GewSt|KSt|ESt)/i.test(c) },
  { bucket: '5100', test: (c) => /^(Grundsteuer|Kfz-Steuer|Umsatzsteuerzahllast)/i.test(c) },
  { bucket: '3600', test: () => true }, // catchall — anything that didn't match above
]

/**
 * Map an Expense.category to a BWA bucket.
 * Returns the 4-digit bucket code. The
 * 3100 / 4100 buckets are NOT matched here
 * (3100 = booked AfA signal, 4100 = not
 * in v1) — callers should handle those
 * separately before falling through to
 * this matcher.
 */
function bucketFor(category: string | null): string {
  const c = category || ''
  for (const m of BWA_BUCKET_MATCHERS) {
    if (m.bucket === '3100' || m.bucket === '4100' || m.bucket === '3600') continue
    if (m.test(c)) return m.bucket
  }
  return '3600' // catchall
}

@Injectable()
export class BwaService {
  constructor(
    private prisma: PrismaService,
    private assets: AssetsService,
  ) {}

  /**
   * Tier 163: Quarterly BWA aggregation.
   *
   * Returns the BWA for a calendar quarter (Q1..Q4)
   * for the given year, PLUS the same quarter for
   * the prior year. The Berater's most common
   * comparison is "this Q vs same Q last year" —
   * seasonality makes Q-vs-Q the apples-to-apples
   * comparison that month-vs-month distorts.
   *
   * Implementation: reuses the existing
   * `compute(year, endMonth)` method. The YTD
   * field of a BWA at quarter end (3, 6, 9, 12) is
   * by definition the Q-Summe. So:
   *   - current Q = compute(year, endMonth).ytd
   *   - prior  Q = compute(year-1, endMonth).ytd
   * Two BWA calls, no new aggregation logic. The
   * frontend renders the diff.
   *
   * Shape: { current: BwaResult, prior: BwaResult,
   *   quarter: 'Q1'|'Q2'|'Q3'|'Q4', year, endMonth,
   *   vorjahr, quarterMonths: [m1, m2, m3] }
   */
  async computeQuarter(
    companyId: string,
    year: number,
    quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4',
  ): Promise<{
    current: BwaResult
    prior: BwaResult
    quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4'
    year: number
    vorjahr: number
    endMonth: number
    quarterMonths: [number, number, number]
  }> {
    const endMonthByQuarter: Record<string, number> = {
      Q1: 3,
      Q2: 6,
      Q3: 9,
      Q4: 12,
    }
    const endMonth = endMonthByQuarter[quarter]
    if (!endMonth) {
      throw new Error(`Ungültiges Quartal: ${quarter}`)
    }
    const startMonth = endMonth - 2
    const current = await this.compute(companyId, year, endMonth)
    const prior = await this.compute(companyId, year - 1, endMonth)
    return {
      current,
      prior,
      quarter,
      year,
      vorjahr: year - 1,
      endMonth,
      quarterMonths: [startMonth, startMonth + 1, endMonth],
    }
  }

  async compute(companyId: string, year: number, month: number): Promise<BwaResult> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company) throw new Error('Company nicht gefunden')

    const vorjahr = year - 1
    const yearStart = new Date(year, 0, 1)
    const monthStart = new Date(year, month - 1, 1)
    const monthEnd = new Date(year, month - 1 + 1, 0, 23, 59, 59, 999)
    const vormonatStart = new Date(year, month - 2, 1)
    const vormonatEnd = new Date(year, month - 1, 0, 23, 59, 59, 999)
    const vorjahresYtdStart = new Date(vorjahr, 0, 1)
    const vorjahresYtdEnd = new Date(vorjahr, month - 1 + 1, 0, 23, 59, 59, 999)

    // Pull invoices + expenses + booked AfA rows
    // for the year so we can filter by month
    // in-memory. Pulling the full year (not 4
    // separate windows) is simpler than 4 parallel
    // queries and gives us consistent counts.
    //
    // Tier 87: we also pull the AfA Expense rows
    // (category='AfA' AND afaYear=year) so the
    // 3100 Abschreibungen line can use real
    // booked values when present, falling back to
    // the in-memory computed value otherwise.
    const [invoices, expenses, assetList, bookedAfaRows] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          status: { in: ['paid', 'sent', 'overdue'] },
          issueDate: { gte: yearStart, lte: monthEnd },
        },
        // Tier 118.5: BWA is a German BWA (Betriebswirtschaftliche
        // Auswertung) which sums everything in EUR. We pull
        // `eurSubtotal` (pre-computed at issue time from the
        // ECB rate) and fall back to `subtotal` for legacy
        // rows that pre-date Tier 118 (the column was added
        // nullable and backfilled for existing rows).
        select: { subtotal: true, eurSubtotal: true, issueDate: true },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          status: { in: ['booked', 'deductible'] },
          // Tier 87: exclude booked AfA rows
          // from the regular expense pool.
          // They are picked up separately
          // via `bookedAfaRows` and feed into
          // 3100 only — not 3600 Sonstige.
          category: { not: 'AfA' },
          invoiceDate: { gte: yearStart, lte: monthEnd },
        },
        select: { grossAmount: true, category: true, invoiceDate: true },
      }),
      this.prisma.asset.findMany({ where: { companyId } }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          category: 'AfA',
          afaYear: year,
          relatedAssetId: { not: null },
        },
        select: { grossAmount: true, invoiceDate: true },
      }),
    ])

    const sumInMonth = (vals: { date: Date; amount: number }[], start: Date, end: Date) =>
      vals
        .filter((v) => v.date >= start && v.date <= end)
        .reduce((s, v) => s + v.amount, 0)

    // Tier 118.5: aggregate in EUR. Prefer eurSubtotal
    // (pre-computed at issue time), fall back to
    // subtotal for legacy rows.
    const eurSubtotal = (i: { subtotal: any; eurSubtotal: any }) =>
      i.eurSubtotal != null ? Number(i.eurSubtotal) : Number(i.subtotal)
    const invoiceMonat = sumInMonth(
      invoices.map((i) => ({ date: i.issueDate, amount: eurSubtotal(i) })),
      monthStart,
      monthEnd,
    )
    const invoiceVormonat = sumInMonth(
      invoices.map((i) => ({ date: i.issueDate, amount: eurSubtotal(i) })),
      vormonatStart,
      vormonatEnd,
    )
    const invoiceYtd = sumInMonth(
      invoices.map((i) => ({ date: i.issueDate, amount: eurSubtotal(i) })),
      yearStart,
      monthEnd,
    )

    // Tier 93: bucket every expense ONCE by its
    // category. The matchers in BWA_BUCKET_MATCHERS
    // produce an 8-character key per expense. We
    // then sum per bucket across the month / YTD
    // windows. The result: 1 filter pass instead
    // of 4 (the old code did material/personal/
    // sonstige/zins separately).
    //
    // Each entry in the map: { date, amount, bucket }.
    //
    // Sign convention: BWA line values are
    // always POSITIVE (the bucket label implies
    // "Aufwand" / "Aufwendungen" / "Steuern", and
    // the formula `erloese - material - ...` treats
    // the positive line value as a deduction).
    // We Math.abs() the amount so the BWA
    // accepts both:
    //   - legacy dev seed data with positive
    //     grossAmount (e.g. the existing Material
    //     rows)
    //   - "correct" accounting sign with negative
    //     grossAmount (= outflow, matches the
    //     signing used in Anlage S / EÜR)
    const bucketedExpenses = expenses.map((e) => ({
      date: e.invoiceDate,
      amount: Math.abs(Number(e.grossAmount)),
      bucket: bucketFor(e.category),
    }))

    // Helper: sum entries in a date window for a
    // specific bucket. Negative amounts (which
    // expenses naturally are) reduce the bucket.
    const sumBucket = (bucket: string, start: Date, end: Date) =>
      sumInMonth(
        bucketedExpenses.filter((e) => e.bucket === bucket).map((e) => ({ date: e.date, amount: e.amount })),
        start,
        end,
      )

    // Per-bucket aggregates (monat + ytd) for the
    // new lines. The old aggregations (material/
    // personal/sonstige/zins) are now specific
    // bucket lookups instead of filter passes.
    const materialMonat = sumBucket('2000', monthStart, monthEnd)
    const personalMonat = sumBucket('3000', monthStart, monthEnd)
    const afaMonat = 0 // filled below from bookedAfaRows
    const raumMonat = sumBucket('3200', monthStart, monthEnd)
    const versicherungMonat = sumBucket('3300', monthStart, monthEnd)
    const werbungMonat = sumBucket('3400', monthStart, monthEnd)
    const instandhaltungMonat = sumBucket('3500', monthStart, monthEnd)
    const sonstigeMonat = sumBucket('3600', monthStart, monthEnd)
    const zinsertragMonat = 0 // 4100 — no data in v1
    const zinsaufwandMonat = sumBucket('4200', monthStart, monthEnd)
    const steuernEinkommenMonat = sumBucket('5000', monthStart, monthEnd)
    const sonstigeSteuernMonat = sumBucket('5100', monthStart, monthEnd)

    const materialYtd = sumBucket('2000', yearStart, monthEnd)
    const personalYtd = sumBucket('3000', yearStart, monthEnd)
    const raumYtd = sumBucket('3200', yearStart, monthEnd)
    const versicherungYtd = sumBucket('3300', yearStart, monthEnd)
    const werbungYtd = sumBucket('3400', yearStart, monthEnd)
    const instandhaltungYtd = sumBucket('3500', yearStart, monthEnd)
    const sonstigeYtd = sumBucket('3600', yearStart, monthEnd)
    const zinsaufwandYtd = sumBucket('4200', yearStart, monthEnd)
    const steuernEinkommenYtd = sumBucket('5000', yearStart, monthEnd)
    const sonstigeSteuernYtd = sumBucket('5100', yearStart, monthEnd)

    // 3100 AfA — Tier 87: prefer booked AfA over
    // computed. When the user has clicked
    // "AfA buchen" for this year, the booked
    // Expense rows are the source of truth and
    // the BWA 3100 line shows them by month
    // (a single Dec-31 booking = 0 for Jan-Nov,
    // full amount for Dec). The YTD column is
    // the cumulative sum of booked rows up to
    // the BWA month. When no AfA has been
    // booked for the year, we fall back to the
    // in-memory computed value (annualAfA/12
    // per month) — same v1 proration logic.
    const totalBookedAfA = bookedAfaRows.reduce(
      (s, e) => s + Math.abs(Number(e.grossAmount)),
      0,
    )
    const useBookedAfA = totalBookedAfA !== 0
    const monthAfA = useBookedAfA
      ? bookedAfaRows
          .filter((e) => e.invoiceDate >= monthStart && e.invoiceDate <= monthEnd)
          .reduce((s, e) => s + Math.abs(Number(e.grossAmount)), 0)
      : assetList.reduce(
          (s, a) => s + (this.assets.computeAfA(a, monthEnd).annualAfA / 12),
          0,
        )
    const ytdAfA = useBookedAfA
      ? bookedAfaRows
          .filter((e) => e.invoiceDate >= yearStart && e.invoiceDate <= monthEnd)
          .reduce((s, e) => s + Math.abs(Number(e.grossAmount)), 0)
      : assetList.reduce(
          (s, a) => s + (this.assets.computeAfA(a, monthEnd).annualAfA * (month / 12)),
          0,
        )

    // Vorjahres-YTD (Jan - same month prior year)
    // — needs separate queries because our
    // in-memory pull only covers the current
    // year. Same for vorjahres invoicing (we
    // don't store prior-year invoices in the
    // current-year query).
    const [vorjahresInvoices, vorjahresExpenses, vorjahresBookedAfa] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          status: { in: ['paid', 'sent', 'overdue'] },
          issueDate: { gte: vorjahresYtdStart, lte: vorjahresYtdEnd },
        },
        // Tier 118.5: prior-year aggregation in EUR.
        // eurSubtotal for multi-currency, fallback to
        // subtotal for legacy null rows.
        select: { subtotal: true, eurSubtotal: true },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          status: { in: ['booked', 'deductible'] },
          // Tier 87: exclude booked AfA from
          // the regular Sonstige filter.
          category: { not: 'AfA' },
          invoiceDate: { gte: vorjahresYtdStart, lte: vorjahresYtdEnd },
        },
        select: { grossAmount: true, category: true },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          category: 'AfA',
          afaYear: vorjahr,
          relatedAssetId: { not: null },
        },
        select: { grossAmount: true, invoiceDate: true },
      }),
    ])

    const vorjahresYtdInvoice = vorjahresInvoices.reduce(
      (s, i) => s + (i.eurSubtotal != null ? Number(i.eurSubtotal) : Number(i.subtotal)),
      0,
    )
    // Tier 93: bucket the prior-year expenses the
    // same way as the current year (one filter
    // pass per expense, one sum per bucket). The
    // vorjahresYtd per-bucket values feed the
    // % change column in the new lines. Same
    // Math.abs() convention as the current year
    // (line values are positive).
    const vorjahresBucketed = vorjahresExpenses.map((e) => ({
      amount: Math.abs(Number(e.grossAmount)),
      bucket: bucketFor(e.category),
    }))
    const vorjahresYtdByBucket = (bucket: string) =>
      vorjahresBucketed.filter((e) => e.bucket === bucket).reduce((s, e) => s + e.amount, 0)

    const vorjahresYtdMaterial = vorjahresYtdByBucket('2000')
    const vorjahresYtdPersonal = vorjahresYtdByBucket('3000')
    const vorjahresYtdRaum = vorjahresYtdByBucket('3200')
    const vorjahresYtdVersicherung = vorjahresYtdByBucket('3300')
    const vorjahresYtdWerbung = vorjahresYtdByBucket('3400')
    const vorjahresYtdInstandhaltung = vorjahresYtdByBucket('3500')
    const vorjahresYtdSonstige = vorjahresYtdByBucket('3600')
    const vorjahresYtdZinsaufwand = vorjahresYtdByBucket('4200')
    const vorjahresYtdSteuernEinkommen = vorjahresYtdByBucket('5000')
    const vorjahresYtdSonstigeSteuern = vorjahresYtdByBucket('5100')

    const vorjahresYtdAfA = vorjahresBookedAfa
      .filter((e) => e.invoiceDate >= vorjahresYtdStart && e.invoiceDate <= vorjahresYtdEnd)
      .reduce((s, e) => s + Math.abs(Number(e.grossAmount)), 0)

    // Sonstige betriebliche Erträge (1300) —
    // positive customer credits in the year.
    const credits = await this.prisma.customerCreditTransaction.findMany({
      where: {
        companyId,
        createdAt: { gte: yearStart, lte: monthEnd },
        type: { in: ['overpayment', 'gutschrift'] },
      },
      select: { amount: true },
    })
    const sonstigeErloeseMonat = sumInMonth(
      credits.map((c) => ({ date: new Date(), amount: Number(c.amount) > 0 ? Number(c.amount) : 0 })),
      monthStart,
      monthEnd,
    )
    const sonstigeErloeseYtd = credits
      .filter((c) => Number(c.amount) > 0)
      .reduce((s, c) => s + Number(c.amount), 0)
    // No prior-year credit data; we use 0
    // (a real BWA would have it from the prior
    // year).
    const sonstigeErloeseVorjahresYtd = 0

    // Build the lines array in DATEV BWA order
    const erloeseMonat = invoiceMonat + sonstigeErloeseMonat
    const erloeseVormonat = invoiceVormonat
    const erloeseYtd = invoiceYtd + sonstigeErloeseYtd
    const erloeseVorjahresYtd = vorjahresYtdInvoice + sonstigeErloeseVorjahresYtd

    // Compute % change vs Vorjahres-YTD per line
    const pctChange = (ytd: number, vor: number) =>
      vor === 0 ? 0 : round2(((ytd - vor) / Math.abs(vor)) * 100)

    const lines: BwaLine[] = [
      {
        bucket: '1000',
        label: 'Umsatzerlöse',
        monat: round2(invoiceMonat),
        vormonat: round2(invoiceVormonat),
        ytd: round2(invoiceYtd),
        vorjahresYtd: round2(vorjahresYtdInvoice),
        ytdChangePct: pctChange(invoiceYtd, vorjahresYtdInvoice),
      },
      {
        bucket: '1300',
        label: 'Sonstige betriebliche Erträge',
        monat: round2(sonstigeErloeseMonat),
        vormonat: 0,
        ytd: round2(sonstigeErloeseYtd),
        vorjahresYtd: round2(sonstigeErloeseVorjahresYtd),
        ytdChangePct: 0,
      },
      {
        bucket: '2000',
        label: 'Materialaufwand',
        monat: round2(materialMonat),
        vormonat: 0,
        ytd: round2(materialYtd),
        vorjahresYtd: round2(vorjahresYtdMaterial),
        ytdChangePct: pctChange(materialYtd, vorjahresYtdMaterial),
      },
      {
        bucket: '3000',
        label: 'Personalkosten',
        monat: round2(personalMonat),
        vormonat: 0,
        ytd: round2(personalYtd),
        vorjahresYtd: round2(vorjahresYtdPersonal),
        ytdChangePct: pctChange(personalYtd, vorjahresYtdPersonal),
      },
      {
        bucket: '3100',
        label: 'Abschreibungen (AfA)',
        monat: round2(monthAfA),
        vormonat: 0,
        ytd: round2(ytdAfA),
        vorjahresYtd: round2(vorjahresYtdAfA),
        ytdChangePct: pctChange(ytdAfA, vorjahresYtdAfA),
      },
      {
        bucket: '3200',
        label: 'Raumkosten (Miete, Heizung, Nebenkosten)',
        monat: round2(raumMonat),
        vormonat: 0,
        ytd: round2(raumYtd),
        vorjahresYtd: round2(vorjahresYtdRaum),
        ytdChangePct: pctChange(raumYtd, vorjahresYtdRaum),
      },
      {
        bucket: '3300',
        label: 'Versicherungen, Beiträge',
        monat: round2(versicherungMonat),
        vormonat: 0,
        ytd: round2(versicherungYtd),
        vorjahresYtd: round2(vorjahresYtdVersicherung),
        ytdChangePct: pctChange(versicherungYtd, vorjahresYtdVersicherung),
      },
      {
        bucket: '3400',
        label: 'Werbung, Reise, Bewirtung',
        monat: round2(werbungMonat),
        vormonat: 0,
        ytd: round2(werbungYtd),
        vorjahresYtd: round2(vorjahresYtdWerbung),
        ytdChangePct: pctChange(werbungYtd, vorjahresYtdWerbung),
      },
      {
        bucket: '3500',
        label: 'Instandhaltung, Wartung, Reparatur',
        monat: round2(instandhaltungMonat),
        vormonat: 0,
        ytd: round2(instandhaltungYtd),
        vorjahresYtd: round2(vorjahresYtdInstandhaltung),
        ytdChangePct: pctChange(instandhaltungYtd, vorjahresYtdInstandhaltung),
      },
      {
        bucket: '3600',
        label: 'Sonstige betriebliche Aufwendungen',
        monat: round2(sonstigeMonat),
        vormonat: 0,
        ytd: round2(sonstigeYtd),
        vorjahresYtd: round2(vorjahresYtdSonstige),
        ytdChangePct: pctChange(sonstigeYtd, vorjahresYtdSonstige),
      },
      {
        // 4100 Zinserträge — no data model in v1
        // (we'd need an "interest income" Expense
        // category or a separate InterestIncome
        // table). Shown as 0 with the disclaimer
        // calling it out.
        bucket: '4100',
        label: 'Zinserträge',
        monat: 0,
        vormonat: 0,
        ytd: 0,
        vorjahresYtd: 0,
        ytdChangePct: 0,
      },
      {
        bucket: '4200',
        label: 'Zinsaufwendungen',
        monat: round2(zinsaufwandMonat),
        vormonat: 0,
        ytd: round2(zinsaufwandYtd),
        vorjahresYtd: round2(vorjahresYtdZinsaufwand),
        ytdChangePct: pctChange(zinsaufwandYtd, vorjahresYtdZinsaufwand),
      },
      {
        bucket: '5000',
        label: 'Steuern vom Einkommen und Ertrag (GewSt, KSt, ESt)',
        monat: round2(steuernEinkommenMonat),
        vormonat: 0,
        ytd: round2(steuernEinkommenYtd),
        vorjahresYtd: round2(vorjahresYtdSteuernEinkommen),
        ytdChangePct: pctChange(steuernEinkommenYtd, vorjahresYtdSteuernEinkommen),
      },
      {
        bucket: '5100',
        label: 'Sonstige Steuern (Grundsteuer, Kfz-Steuer)',
        monat: round2(sonstigeSteuernMonat),
        vormonat: 0,
        ytd: round2(sonstigeSteuernYtd),
        vorjahresYtd: round2(vorjahresYtdSonstigeSteuern),
        ytdChangePct: pctChange(sonstigeSteuernYtd, vorjahresYtdSonstigeSteuern),
      },
    ]

    // Tier 93: Betriebsergebnis now subtracts the
    // 4 new operating-expense lines (3200/3300/
    // 3400/3500) in addition to the original
    // 2000/3000/3100/3600. The Finanzergebnis
    // (4100-4200) and Steuern (5000+5100) are
    // NOT in the Betriebsergebnis — they sit
    // below the operating result per § 275 HGB.
    const betriebsergebnisMonat =
      erloeseMonat -
      materialMonat -
      personalMonat -
      monthAfA -
      raumMonat -
      versicherungMonat -
      werbungMonat -
      instandhaltungMonat -
      sonstigeMonat
    const betriebsergebnisYtd =
      erloeseYtd -
      materialYtd -
      personalYtd -
      ytdAfA -
      raumYtd -
      versicherungYtd -
      werbungYtd -
      instandhaltungYtd -
      sonstigeYtd
    const betriebsergebnisVorjahresYtd =
      erloeseVorjahresYtd -
      vorjahresYtdMaterial -
      vorjahresYtdPersonal -
      vorjahresYtdAfA -
      vorjahresYtdRaum -
      vorjahresYtdVersicherung -
      vorjahresYtdWerbung -
      vorjahresYtdInstandhaltung -
      vorjahresYtdSonstige

    // Tier 93: Finanzergebnis + Steuern + Jahresergebnis
    // — the bottom of the § 275 HGB GKV. 4100 is
    // 0 in v1, so finanzergebnis = -4200.
    const finanzergebnisMonat = zinsertragMonat - zinsaufwandMonat
    const finanzergebnisYtd = -zinsaufwandYtd
    const finanzergebnisVorjahresYtd = -vorjahresYtdZinsaufwand
    const steuernMonat = steuernEinkommenMonat + sonstigeSteuernMonat
    const steuernYtd = steuernEinkommenYtd + sonstigeSteuernYtd
    const steuernVorjahresYtd = vorjahresYtdSteuernEinkommen + vorjahresYtdSonstigeSteuern
    const jahresergebnisMonat = round2(
      betriebsergebnisMonat + finanzergebnisMonat - steuernMonat,
    )
    const jahresergebnisYtd = round2(
      betriebsergebnisYtd + finanzergebnisYtd - steuernYtd,
    )
    const jahresergebnisVorjahresYtd = round2(
      betriebsergebnisVorjahresYtd + finanzergebnisVorjahresYtd - steuernVorjahresYtd,
    )

    return {
      year,
      month,
      vorjahr,
      company: {
        name: company.name,
        legalName: company.legalName,
      },
      lines,
      totals: {
        erloeseMonat: round2(erloeseMonat),
        erloeseVormonat: round2(erloeseVormonat),
        erloeseYtd: round2(erloeseYtd),
        erloeseVorjahresYtd: round2(erloeseVorjahresYtd),
        materialaufwandMonat: round2(materialMonat),
        personalaufwandMonat: round2(personalMonat),
        abschreibungenMonat: round2(monthAfA),
        sonstigeMonat: round2(sonstigeMonat),
        betriebsergebnisMonat: round2(betriebsergebnisMonat),
        betriebsergebnisYtd: round2(betriebsergebnisYtd),
        betriebsergebnisVorjahresYtd: round2(betriebsergebnisVorjahresYtd),
        finanzergebnisMonat: round2(finanzergebnisMonat),
        finanzergebnisYtd: round2(finanzergebnisYtd),
        finanzergebnisVorjahresYtd: round2(finanzergebnisVorjahresYtd),
        steuernMonat: round2(steuernMonat),
        steuernYtd: round2(steuernYtd),
        steuernVorjahresYtd: round2(steuernVorjahresYtd),
        jahresergebnisMonat,
        jahresergebnisYtd,
        jahresergebnisVorjahresYtd,
      },
      counts: {
        invoices: invoices.length,
        expenses: expenses.length,
        assets: assetList.length,
        // Tier 87: how many AfA bookings exist
        // for this year. 0 = computed fallback
        // for the 3100 line; >0 = real booked
        // AfA Expense rows.
        afaBookings: bookedAfaRows.length,
      },
      // Tier 87: expose to the UI which mode
      // the 3100 line is in ('booked' from
      // Expense rows, or 'computed' from the
      // Asset pool).
      afaSource: useBookedAfA ? 'booked' : 'computed',
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese BWA ist eine VORSCHAU basierend auf den in de-invoice v1 verfügbaren ' +
        'Daten. Die 4100 Zinserträge sind im Berichtszeitraum 0 (kein eigenes ' +
        'Zinsertrag-Modell — der Berater ergänzt diese aus dem SKR03-Konto 4100). ' +
        'Beteiligungserträge (4400) und Beteiligungs-Abschreibungen (4500) sind ' +
        'nicht ausgewiesen. Bestandsveränderungen (1100) und aktivierte Eigen-' +
        'leistungen (1200) erfordern eine Bilanz und sind nicht abgedeckt. ' +
        'Der Steuerberater ergänzt die fehlenden Positionen aus dem SKR03.',
    }
  }

  /**
   * Render the BWA as a GoBD-style A4 PDF.
   * Single-page landscape (the BWA has 5
   * numeric columns + bucket codes + labels;
   * landscape gives the columns room to
   * breathe).
   */
  async renderPdf(companyId: string, year: number, month: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year, month)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="BWA-${year}-${String(month).padStart(2, '0')}.pdf"`,
    )

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40 })
    doc.pipe(res)

    // Header
    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .text(`BWA — Betriebswirtschaftliche Auswertung`, { align: 'left' })
    doc
      .fontSize(9)
      .font('Helvetica')
      .text(
        `${data.company.legalName || data.company.name}  |  ${this.monthName(month)} ${year}  |  Vorjahres-Vergleich: Jan-${this.monthName(month)} ${data.vorjahr}`,
      { align: 'left' },
      )
    doc.moveDown(0.5)

    // Table
    const colBucket = 40
    const colLabel = 80
    const colMonat = 250
    const colVormonat = 350
    const colYtd = 440
    const colVorYtd = 540
    const colChange = 640

    // Header row
    doc.fontSize(9).font('Helvetica-Bold')
    const headerY = doc.y
    doc.text('Konto', colBucket, headerY, { width: 35 })
    doc.text('Bezeichnung', colLabel, headerY, { width: 165 })
    doc.text('Monat', colMonat, headerY, { width: 90, align: 'right' })
    doc.text('Vormonat', colVormonat, headerY, { width: 85, align: 'right' })
    doc.text('YTD', colYtd, headerY, { width: 95, align: 'right' })
    doc.text('Vorj.-YTD', colVorYtd, headerY, { width: 95, align: 'right' })
    doc.text('Δ %', colChange, headerY, { width: 95, align: 'right' })
    doc.moveDown(0.4)
    doc.moveTo(40, doc.y).lineTo(740, doc.y).stroke()

    // Body rows
    doc.font('Helvetica').fontSize(9)
    for (const l of data.lines) {
      const y = doc.y
      doc.text(l.bucket, colBucket, y, { width: 35 })
      doc.text(l.label, colLabel, y, { width: 165 })
      doc.text(this.fmtEur(l.monat), colMonat, y, { width: 90, align: 'right' })
      doc.text(this.fmtEur(l.vormonat), colVormonat, y, { width: 85, align: 'right' })
      doc.text(this.fmtEur(l.ytd), colYtd, y, { width: 95, align: 'right' })
      doc.text(this.fmtEur(l.vorjahresYtd), colVorYtd, y, { width: 95, align: 'right' })
      doc.text(this.fmtPct(l.ytdChangePct), colChange, y, { width: 95, align: 'right' })
      doc.moveDown(0.3)
    }

    // Summary: Betriebsergebnis
    doc.moveDown(0.4)
    doc.moveTo(40, doc.y).lineTo(740, doc.y).stroke()
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold').fontSize(10)
    const sumY = doc.y
    doc.text('Betriebsergebnis', colLabel, sumY, { width: 165 })
    doc.text(this.fmtEur(data.totals.betriebsergebnisMonat), colMonat, sumY, { width: 90, align: 'right' })
    doc.text('—', colVormonat, sumY, { width: 85, align: 'right' })
    doc.text(this.fmtEur(data.totals.betriebsergebnisYtd), colYtd, sumY, { width: 95, align: 'right' })
    doc.text(this.fmtEur(data.totals.betriebsergebnisVorjahresYtd), colVorYtd, sumY, { width: 95, align: 'right' })
    doc.text(
      this.fmtPct(
        data.totals.betriebsergebnisVorjahresYtd === 0
          ? 0
          : ((data.totals.betriebsergebnisYtd - data.totals.betriebsergebnisVorjahresYtd) /
              Math.abs(data.totals.betriebsergebnisVorjahresYtd)) *
              100,
      ),
      colChange,
      sumY,
      { width: 95, align: 'right' },
    )

    // Tier 93: Finanzergebnis + Steuern + Jahresergebnis
    // — the bottom of the § 275 HGB GKV.
    doc.moveDown(0.3)
    const finY = doc.y
    doc.text('Finanzergebnis (4100-4200)', colLabel, finY, { width: 165 })
    doc.text(this.fmtEur(data.totals.finanzergebnisMonat), colMonat, finY, { width: 90, align: 'right' })
    doc.text('—', colVormonat, finY, { width: 85, align: 'right' })
    doc.text(this.fmtEur(data.totals.finanzergebnisYtd), colYtd, finY, { width: 95, align: 'right' })
    doc.text(this.fmtEur(data.totals.finanzergebnisVorjahresYtd), colVorYtd, finY, { width: 95, align: 'right' })
    doc.text('—', colChange, finY, { width: 95, align: 'right' })

    doc.moveDown(0.3)
    const stY = doc.y
    doc.text('Steuern (5000+5100)', colLabel, stY, { width: 165 })
    doc.text(this.fmtEur(data.totals.steuernMonat), colMonat, stY, { width: 90, align: 'right' })
    doc.text('—', colVormonat, stY, { width: 85, align: 'right' })
    doc.text(this.fmtEur(data.totals.steuernYtd), colYtd, stY, { width: 95, align: 'right' })
    doc.text(this.fmtEur(data.totals.steuernVorjahresYtd), colVorYtd, stY, { width: 95, align: 'right' })
    doc.text('—', colChange, stY, { width: 95, align: 'right' })

    doc.moveDown(0.3)
    doc.moveTo(40, doc.y).lineTo(740, doc.y).stroke()
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold').fontSize(11)
    const jErgY = doc.y
    doc.text('Jahresergebnis', colLabel, jErgY, { width: 165 })
    doc.text(this.fmtEur(data.totals.jahresergebnisMonat), colMonat, jErgY, { width: 90, align: 'right' })
    doc.text('—', colVormonat, jErgY, { width: 85, align: 'right' })
    doc.text(this.fmtEur(data.totals.jahresergebnisYtd), colYtd, jErgY, { width: 95, align: 'right' })
    doc.text(this.fmtEur(data.totals.jahresergebnisVorjahresYtd), colVorYtd, jErgY, { width: 95, align: 'right' })
    doc.text(
      this.fmtPct(
        data.totals.jahresergebnisVorjahresYtd === 0
          ? 0
          : ((data.totals.jahresergebnisYtd - data.totals.jahresergebnisVorjahresYtd) /
              Math.abs(data.totals.jahresergebnisVorjahresYtd)) *
              100,
      ),
      colChange,
      jErgY,
      { width: 95, align: 'right' },
    )

    // Disclaimer
    doc.moveDown(1)
    doc.fontSize(7).font('Helvetica-Oblique').fillColor('#666')
    doc.text(data.disclaimer, { width: 700 })
    doc.fillColor('#000')

    // Footer
    doc
      .fontSize(6)
      .font('Helvetica')
      .fillColor('#999')
      .text(
        `Erstellt: ${new Date(data.generatedAt).toLocaleString('de-DE')}  |  ` +
          `Rechnungen: ${data.counts.invoices}  |  Ausgaben: ${data.counts.expenses}  |  ` +
          `Anlagen: ${data.counts.assets}  |  de-invoice · BWA Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private fmtEur(n: number): string {
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }

  private fmtPct(n: number): string {
    if (n === 0) return '—'
    const sign = n > 0 ? '+' : ''
    return `${sign}${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(n)} %`
  }

  private monthName(m: number): string {
    return [
      'Januar',
      'Februar',
      'März',
      'April',
      'Mai',
      'Juni',
      'Juli',
      'August',
      'September',
      'Oktober',
      'November',
      'Dezember',
    ][m - 1]
  }
}
