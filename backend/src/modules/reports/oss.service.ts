import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { normaliseCountry } from '../invoice/ust-behandlung-detector'
import { invoiceTaxBreakdown } from '../invoice/tax-breakdown'
import { consumerAbroad, isGermanRate } from './oss-scope'

/**
 * Tier 78: EU OSS (One-Stop-Shop) — quarterly
 * B2C distance-sales declaration.
 *
 * Background: the EU OSS scheme (effective since
 * 2021-07-01) lets a business selling B2C
 * cross-border within the EU file ONE quarterly
 * declaration in their home member state, rather
 * than registering for VAT in every country they
 * sell to. Each quarter the user reports:
 *
 *   - per destination country
 *   - per VAT rate of that country
 *   - net amount (B2C sales)
 *   - VAT amount (collected at the destination rate)
 *
 * The result is uploaded to the BZSt-OSS portal
 * (Bundeszentralamt für Steuern). The portal expects
 * a structured XML/PDF; we surface a JSON preview +
 * a CSV the user can reformat in Excel before the
 * upload.
 *
 * Filter: an invoice is in scope for OSS if:
 *   - the customer's address.country is in the EU
 *   - the customer has NO VAT ID (B2B uses
 *     reverse-charge §13b / igL instead — those go
 *     on the regular UStVA, not OSS)
 *   - the customer is in a DIFFERENT EU country
 *     than the company (domestic B2C stays on
 *     regular UStVA)
 *   - the invoice status is in [paid, sent, overdue]
 *     (drafts are not billable yet, so they're not
 *     in the OSS report either)
 *   - the invoice is a regular INV (not a Gutschrift
 *     CN — credit notes are deducted from the
 *     original destination's bucket; a v2 could
 *     surface them as offsets)
 *
 * Output: per (country, vatRate) line + per-country
 * subtotal + grand total. Same shape as the BZSt
 * OSS-Retourmeldung expects.
 */

// EU-27 as of 2024. Mirrors the set in
// ust-behandlung-detector.ts (tier 62). Kept as a
// local copy so the OSS service is self-contained —
// if a country leaves or joins the EU, both places
// need to be updated (the detector for USt
// treatment, this one for the OSS scope).
const EU_COUNTRY_CODES = new Set<string>([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
])

// German country names for the UI / PDF / CSV.
// Order: alphabetically by ISO-3166-1 alpha-2.
const COUNTRY_NAMES_DE: Record<string, string> = {
  AT: 'Österreich',
  BE: 'Belgien',
  BG: 'Bulgarien',
  CY: 'Zypern',
  CZ: 'Tschechien',
  DE: 'Deutschland',
  DK: 'Dänemark',
  EE: 'Estland',
  ES: 'Spanien',
  FI: 'Finnland',
  FR: 'Frankreich',
  GR: 'Griechenland',
  HR: 'Kroatien',
  HU: 'Ungarn',
  IE: 'Irland',
  IT: 'Italien',
  LT: 'Litauen',
  LU: 'Luxemburg',
  LV: 'Lettland',
  MT: 'Malta',
  NL: 'Niederlande',
  PL: 'Polen',
  PT: 'Portugal',
  RO: 'Rumänien',
  SE: 'Schweden',
  SI: 'Slowenien',
  SK: 'Slowakei',
}

export interface OssLine {
  /** ISO-3166-1 alpha-2 destination country code */
  country: string
  /** German display name of the destination country */
  countryName: string
  /** VAT rate applied (fraction, e.g. 0.19 for 19%) */
  vatRate: number
  /** Net amount at this VAT rate */
  netAmount: number
  /** VAT amount at this VAT rate */
  vatAmount: number
  /** Gross = net + VAT */
  grossAmount: number
  /** Distinct invoice count contributing to this line */
  invoiceCount: number
}

export interface OssCountryTotal {
  country: string
  countryName: string
  netAmount: number
  vatAmount: number
  grossAmount: number
  /** Distinct invoice count for this country */
  invoiceCount: number
  /** Per-VAT-rate breakdown (sorted desc by rate) */
  vatRates: OssLine[]
}

export interface OssResult {
  year: number
  /** 1-4 */
  quarter: number
  companyId: string
  /** Company's own country (the home member state) */
  homeCountry: string
  countries: OssCountryTotal[]
  totals: {
    netAmount: number
    vatAmount: number
    grossAmount: number
    invoiceCount: number
    /** Tier 641: the tax of the corrections of earlier quarters (negative for credit notes) */
    correctionsVat: number
    /** …and what the return comes to: this quarter's tax and the corrections */
    vatDue: number
  }
  /**
   * Tier 641: credit notes of this quarter for sales of an earlier one. The
   * OSS return states them apart, per member state and period corrected; a
   * credit note for a sale of the same quarter is in that sale's line.
   */
  corrections: Array<{
    country: string
    countryName: string
    year: number
    quarter: number
    netAmount: number
    vatAmount: number
  }>
  /** Counts filtered for visibility (so the user
   *  can see "X EU B2C, Y excluded because B2B,
   *  Z excluded because non-EU") */
  counts: {
    eligible: number
    excludedB2B: number
    excludedSameCountry: number
    excludedNonEU: number
    excludedDraft: number
    /** Tier 649: sales to consumers abroad at a German rate by a company that is not in the OSS scheme — German tax, in the UStVA */
    excludedGermanRate: number
  }
  /** Tier 649: the company's setting */
  ossVerfahren: boolean
  generatedAt: string
  disclaimer: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

interface CountryItem {
  invoiceId: string
  vatRate: number
  net: number
  vat: number
  gross: number
}

@Injectable()
export class OssService {
  constructor(private prisma: PrismaService) {}

  async compute(
    companyId: string,
    year: number,
    quarter: number,
  ): Promise<OssResult> {
    // Quarter → [start, end] inclusive. Q1 = Jan-Mar,
    // Q4 = Oct-Dec. end is the LAST day of the last
    // month of the quarter (23:59:59.999) so any
    // issueDate on the 31st is included.
    const startMonth = (quarter - 1) * 3
    const start = new Date(year, startMonth, 1)
    const end = new Date(year, startMonth + 3, 0, 23, 59, 59, 999)

    // Home country = the company's own address.country
    // (the EU member state where the OSS declaration
    // gets filed). Domestic B2C sales to this country
    // are EXCLUDED from OSS — they stay on the
    // regular UStVA.
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { address: true, ossVerfahren: true },
    })
    // Tier 649: a company that is not in the OSS scheme charges German tax
    // on a sale to a consumer abroad at 19 % / 7 % — that sale is in the
    // UStVA and not here. One that is in it has every such sale here.
    const inOss = company?.ossVerfahren === true
    const homeCountryRaw = (company?.address as any)?.country || 'DE'
    const homeCountry = normaliseCountry(homeCountryRaw) || 'DE'

    // Pull all in-period invoices with their items
    // and the customer's country / VAT ID. We
    // include even non-EU + B2B rows in this
    // query so we can surface the exclusion
    // counts in the response.
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: start, lte: end },
        // status filter excludes 'cancelled' but
        // we still pull 'draft' so we can count
        // them in the excludedDraft bucket.
        status: { in: ['paid', 'sent', 'overdue', 'draft'] },
        // Only INV — Gutschrift (CN) gets its own
        // bucket on the UStVA / Anlage EÜR, not OSS.
        // Tier 424: a Quittung is a sale as well.
        type: { in: ['INV', 'RCV'] },
      },
      include: {
        customer: {
          select: { id: true, vatId: true, address: true },
        },
        items: {
          select: {
            vatRate: true,
            netAmount: true,
            vatAmount: true,
            grossAmount: true,
            // Tier 409: the per-rate split is weighted by quantity × price.
            quantity: true,
            unitPrice: true,
          },
        },
      },
    })

    // Filter into buckets. We count every category
    // of exclusion so the UI / CSV can surface
    // "you had 12 non-EU invoices this quarter" —
    // useful for sanity-checking the report.
    //
    // Each item carries its invoiceId so we can
    // compute the per-(country, vatRate) distinct
    // invoice count correctly: a multi-rate invoice
    // contributes to multiple rate-buckets but only
    // counts as 1 in each.
    const countryItems = new Map<string, CountryItem[]>()
    const countryInvoiceIds = new Map<string, Set<string>>()
    let excludedB2B = 0
    let excludedSameCountry = 0
    let excludedNonEU = 0
    let excludedDraft = 0
    const germanRate = new Set<string>()

    for (const inv of invoices) {
      // Drafts: separate counter; never in any bucket.
      if (inv.status === 'draft') {
        excludedDraft++
        continue
      }
      const customer = inv.customer
      if (!customer) continue
      const custAddr = (customer.address as any) || {}
      const country = normaliseCountry(custAddr.country)
      const hasVatId = !!(customer.vatId && customer.vatId.trim())

      if (!country || !EU_COUNTRY_CODES.has(country)) {
        excludedNonEU++
        continue
      }
      if (hasVatId) {
        // EU B2B → reverse-charge / igL, NOT OSS.
        excludedB2B++
        continue
      }
      if (country === homeCountry) {
        // Same-country B2C → domestic UStVA, NOT OSS.
        excludedSameCountry++
        continue
      }

      // Eligible: EU B2C in a different country.
      // Tier 409: per rate, after the invoice discount (see tax-breakdown.ts).
      // Tier 649: without the amounts that are German tax for a company not
      // in the OSS scheme — an invoice that has nothing else is not counted,
      // and its country gets no line.
      const own = invoiceTaxBreakdown(inv).byRate.filter((bucket) => {
        const german = !inOss && bucket.rate > 0 && isGermanRate(bucket.rate, inv.issueDate)
        if (german) germanRate.add(inv.id)
        return !german
      })
      if (own.length === 0) continue
      let items = countryItems.get(country)
      if (!items) {
        items = []
        countryItems.set(country, items)
      }
      let ids = countryInvoiceIds.get(country)
      if (!ids) {
        ids = new Set()
        countryInvoiceIds.set(country, ids)
      }
      ids.add(inv.id)
      for (const bucket of own) {
        items.push({
          invoiceId: inv.id,
          vatRate: bucket.rate,
          net: bucket.net,
          vat: bucket.vat,
          gross: bucket.net + bucket.vat,
        })
      }
    }

    // Tier 641: credit notes. They were left out — a sale credited in full
    // stayed in the return with its tax. A credit note of this quarter for a
    // sale of this quarter lowers that sale's line; for a sale of an earlier
    // quarter it is a correction of that quarter, stated apart.
    const creditNotes = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: start, lte: end },
        status: { in: ['paid', 'sent', 'overdue'] },
        type: 'CN',
        referenceInvoiceId: { not: null },
      },
      include: {
        customer: { select: { id: true, vatId: true, address: true } },
        referenceInvoice: { select: { id: true, issueDate: true } },
        items: { select: { vatRate: true, netAmount: true, vatAmount: true, grossAmount: true, quantity: true, unitPrice: true } },
      },
    })
    const corrections = new Map<string, { country: string; year: number; quarter: number; net: number; vat: number }>()
    for (const cn of creditNotes) {
      const country = consumerAbroad(cn.customer, homeCountry)
      const ref = cn.referenceInvoice
      if (!country || !ref) continue
      const sameQuarter = ref.issueDate >= start && ref.issueDate <= end
      for (const bucket of invoiceTaxBreakdown(cn).byRate) {
        if (!inOss && bucket.rate > 0 && isGermanRate(bucket.rate, ref.issueDate)) continue
        if (sameQuarter) {
          let items = countryItems.get(country)
          if (!items) {
            items = []
            countryItems.set(country, items)
          }
          // under the sale's id: the line's count stays the number of sales
          items.push({ invoiceId: ref.id, vatRate: bucket.rate, net: bucket.net, vat: bucket.vat, gross: bucket.net + bucket.vat })
        } else {
          const y = ref.issueDate.getUTCFullYear()
          const qu = Math.floor(ref.issueDate.getUTCMonth() / 3) + 1
          const key = `${country}|${y}|${qu}`
          const c = corrections.get(key) ?? { country, year: y, quarter: qu, net: 0, vat: 0 }
          c.net += bucket.net
          c.vat += bucket.vat
          corrections.set(key, c)
        }
      }
    }

    // Build the (country, vatRate) lines. We merge
    // across all items of an invoice in the same
    // country so the same rate is summed.
    const countries: OssCountryTotal[] = []
    let totalNet = 0
    let totalVat = 0
    let totalGross = 0
    let totalInvoices = 0

    for (const [country, items] of countryItems.entries()) {
      const ids = countryInvoiceIds.get(country) || new Set<string>()
      const countryName =
        COUNTRY_NAMES_DE[country] || country

      // Aggregate by vatRate within the country.
      // Keep a per-rate Set<invoiceId> so the
      // per-line count is "how many distinct
      // invoices contributed at this rate" — not
      // "how many items contributed" (an invoice
      // with 2 items at 19% counts as 1).
      const byRate = new Map<
        number,
        {
          net: number
          vat: number
          gross: number
          invoiceIds: Set<string>
        }
      >()
      for (const item of items) {
        let rb = byRate.get(item.vatRate)
        if (!rb) {
          rb = {
            net: 0,
            vat: 0,
            gross: 0,
            invoiceIds: new Set(),
          }
          byRate.set(item.vatRate, rb)
        }
        rb.net += item.net
        rb.vat += item.vat
        rb.gross += item.gross
        rb.invoiceIds.add(item.invoiceId)
      }

      const vatRates: OssLine[] = []
      let cNet = 0
      let cVat = 0
      let cGross = 0
      for (const [rate, b] of byRate.entries()) {
        vatRates.push({
          country,
          countryName,
          vatRate: rate,
          netAmount: round2(b.net),
          vatAmount: round2(b.vat),
          grossAmount: round2(b.gross),
          invoiceCount: b.invoiceIds.size,
        })
        cNet += b.net
        cVat += b.vat
        cGross += b.gross
      }
      // Sort by rate desc (standard 19/7/0 typically
      // appears first; works for AT 20% / DE 19% too
      // because each country has its own rates).
      vatRates.sort((a, b) => b.vatRate - a.vatRate)

      countries.push({
        country,
        countryName,
        netAmount: round2(cNet),
        vatAmount: round2(cVat),
        grossAmount: round2(cGross),
        invoiceCount: ids.size,
        vatRates,
      })
      totalNet += cNet
      totalVat += cVat
      totalGross += cGross
      totalInvoices += ids.size
    }

    // Sort countries by gross amount desc — same UX
    // as every other report in de-invoice.
    countries.sort((a, b) => b.grossAmount - a.grossAmount)

    const correctionList = [...corrections.values()]
      .map((c) => ({
        country: c.country,
        countryName: COUNTRY_NAMES_DE[c.country] || c.country,
        year: c.year,
        quarter: c.quarter,
        netAmount: round2(c.net),
        vatAmount: round2(c.vat),
      }))
      .filter((c) => c.netAmount !== 0 || c.vatAmount !== 0)
      .sort((a, b) => a.year - b.year || a.quarter - b.quarter || a.country.localeCompare(b.country))
    const correctionsVat = round2(correctionList.reduce((sum, c) => sum + c.vatAmount, 0))

    return {
      year,
      quarter,
      companyId,
      homeCountry,
      countries,
      totals: {
        netAmount: round2(totalNet),
        vatAmount: round2(totalVat),
        grossAmount: round2(totalGross),
        invoiceCount: totalInvoices,
        correctionsVat,
        vatDue: round2(round2(totalVat) + correctionsVat),
      },
      corrections: correctionList,
      counts: {
        eligible: totalInvoices,
        excludedB2B,
        excludedSameCountry,
        excludedNonEU,
        excludedDraft,
        excludedGermanRate: germanRate.size,
      },
      ossVerfahren: inOss,
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus EU-B2C-Rechnungen generiert. ' +
        'Die endgültige OSS-Retourmeldung erfolgt über das BZSt-OSS-Portal — ' +
        'bitte vor der Einreichung die Summen und Steuersätze prüfen.',
    }
  }

  /**
   * CSV export for the OSS-Retourmeldung. Layout:
   *   Mitgliedstaat;USt-Satz;Netto (EUR);USt (EUR);Brutto (EUR);Rechnungen
   *   one row per (country, vatRate)
   *   empty row
   *   Summe;...;...;...;...;...
   *
   * German semicolon format (matches what DATEV /
   * BZSt expect). UTF-8 (no BOM — the BZSt portal
   * accepts UTF-8 directly).
   */
  async renderCsv(
    companyId: string,
    year: number,
    quarter: number,
  ): Promise<string> {
    const data = await this.compute(companyId, year, quarter)
    const lines: string[] = []
    lines.push(
      'Mitgliedstaat;USt-Satz;Netto (EUR);USt (EUR);Brutto (EUR);Rechnungen',
    )
    for (const c of data.countries) {
      for (const v of c.vatRates) {
        lines.push(
          [
            c.countryName,
            formatPct(v.vatRate),
            fmtDe(v.netAmount),
            fmtDe(v.vatAmount),
            fmtDe(v.grossAmount),
            String(v.invoiceCount),
          ].join(';'),
        )
      }
    }
    lines.push('')
    lines.push(
      [
        'Summe',
        '',
        fmtDe(data.totals.netAmount),
        fmtDe(data.totals.vatAmount),
        fmtDe(data.totals.grossAmount),
        String(data.totals.invoiceCount),
      ].join(';'),
    )
    // Tier 641: the corrections of earlier quarters, when there are any
    if (data.corrections.length > 0) {
      lines.push('')
      lines.push('Berichtigungen früherer Zeiträume;Zeitraum;Netto (EUR);USt (EUR)')
      for (const c of data.corrections) {
        lines.push([c.countryName, `Q${c.quarter}/${c.year}`, fmtDe(c.netAmount), fmtDe(c.vatAmount)].join(';'))
      }
      lines.push(['Zu zahlen (Quartal und Berichtigungen)', '', '', fmtDe(data.totals.vatDue)].join(';'))
    }
    return lines.join('\n') + '\n'
  }
}

function formatPct(rate: number): string {
  // 0.19 → "19,00 %" (German format; space matches
  // the DATEV-style export the BZSt portal accepts)
  return `${(rate * 100).toFixed(2).replace('.', ',')} %`
}

function fmtDe(n: number): string {
  // German number format with thousand-separator dot
  // and decimal comma. No EUR symbol (the column
  // header says "EUR" already).
  return n
    .toFixed(2)
    .replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
