/**
 * DATEV Buchungsstapel export — ASCII CSV in DATEV 5.0
 * format for Steuerberater to import into DATEV
 * Rechnungswesen.
 *
 * Format reference:
 *   - "DATEV-Format 5.0" (current)
 *   - CSV with `;` delimiter, `"` quote (doubled inside)
 *   - Windows-1252 (Latin-1) encoding, NOT UTF-8
 *   - Header line: 25 columns with file metadata
 *   - Data lines: 32+ columns with one Buchung per line
 *   - Decimals: dot as separator, no thousands, leading sign
 *   - S/H-Vz: Soll = "S", Haben = "H"
 *
 * Sachkontenlänge = 4 (Standard for SKR03 / SKR04)
 * For our default SKR03 mapping:
 *   - 1400   Bank
 *   - 1200   Bank (Sparkasse) — fallback
 *   - 8400   Erlöse 19% USt (Erlöse als implizit 19%)
 *   - 8300   Erlöse 7% USt
 *   - 1776   Umsatzsteuer 19% (Verbindlichkeit)
 *   - 1760   Vorsteuer 19% (Forderung, §15 UStG)
 *   - 1406   Forderungen aus Lieferungen und Leistungen
 *   - 1600   Verbindlichkeiten (Kreditoren)
 *   - 3300   SKR03 Verbindlichkeiten
 *
 * Per Steuerberater convention we ALSO write a Rechnungs-
 * bezeichnung (Belegfeld 1) and a Buchungstext with the
 * original invoice number embedded, so the Berater can
 * trace every line back to the source document.
 */

import { PrismaService } from '../../prisma/prisma.service';

const DELIM = ';'
const QUOTE = '"'

/** Per-company DATEV account mapping. Stored as
 *  `Company.settings.datev` in the DB. Fields the user
 *  doesn't override fall back to SKR03_DEFAULTS via
 *  `resolveDatevAccounts()`. */
export interface DatevAccountMap {
  bank: string
  receivable: string
  payable: string
  revenue19: string
  revenue7: string
  revenue0: string
  vatPayable19: string
  vatPayable7: string
  inputVat19: string
  inputVat7: string
  inputVatIgE: string
  inputVatReverseCharge: string
  expenseDefault: string
}

/** DATEV SKR03 default mapping. Stored on the company
 *  (`Company.settings.datev`) so the Berater can override
 *  individual accounts without forking the app. Used as
 *  fallback when a field is missing from the per-company
 *  config. */
export const SKR03_DEFAULTS: DatevAccountMap = {
  bank: '1200',                 // Bank (Sparkasse etc.)
  receivable: '1406',           // Forderungen aus L+L
  payable: '1600',              // Verbindlichkeiten
  revenue19: '8400',            // Erlöse 19%
  revenue7: '8300',             // Erlöse 7%
  revenue0: '8125',             // Erlöse 0% (igL)
  vatPayable19: '1776',         // USt 19% (Verbindlichkeit)
  vatPayable7: '1760',          // USt 7%
  inputVat19: '1576',           // Vorsteuer 19% (Bezugskonto)
  inputVat7: '1577',           // Vorsteuer 7%  (Bezugskonto)
  // Vorsteuer aus innergemeinschaftlichem Erwerb
  // (IgE, §1a UStG). Standard SKR03: 1782. The user
  // may override if their Berater uses a different
  // mapping.
  inputVatIgE: '1782',
  // §13b UStG: the Leistungsempfänger (we) owes VAT
  // ourselves. Standard SKR03: 1780
  // (Umsatzsteuer-Vorauszahlungen) is the typical
  // booking account because §13b UStG mirrors the
  // §17c UStG — VAT we owe goes to the same clearing
  // account as the USt we owe from our own sales.
  // Some Berater use 1787; that's why this is
  // configurable.
  inputVatReverseCharge: '1780',
  expenseDefault: '4900',      // Sonstige betriebliche Aufwendungen
}

/** Merge a partial per-company config over the SKR03
 *  defaults. Anything the user hasn't filled in keeps
 *  the default. This is what `buildBuchungenFromDb`
 *  actually uses. */
export function resolveDatevAccounts(overrides: Partial<DatevAccountMap> | null | undefined): DatevAccountMap {
  if (!overrides) return { ...SKR03_DEFAULTS }
  return { ...SKR03_DEFAULTS, ...overrides }
}

/** Type guard: pick valid 4-digit numeric account numbers
 *  out of an arbitrary user-submitted object. Reject
 *  anything that's not exactly 4 digits, because DATEV
 *  reserves the field width and a malformed number
 *  would shift every subsequent column. */
export function sanitizeDatevConfig(input: any): Partial<DatevAccountMap> {
  if (!input || typeof input !== 'object') return {}
  const out: Partial<DatevAccountMap> = {}
  for (const k of Object.keys(SKR03_DEFAULTS) as (keyof DatevAccountMap)[]) {
    const v = input[k]
    if (typeof v === 'string' && /^\d{3,5}$/.test(v)) {
      // Right-pad to exactly 4 chars (DATEV Sachkontenlänge
      // is 4 in the header for SKR03; SKR04 also uses 4).
      out[k] = v.padEnd(4, '0').substring(0, 5)
    }
  }
  return out
}

export interface DatevExportInput {
  company: {
    id: string
    name: string
    taxId?: string | null
    // Optional DATEV-Identifikations. The Berater hands
    // these to the client (5-digit Berater-Nr, 5-digit
    // Mandanten-Nr). If not set, we use placeholders
    // (00000) that the Berater overwrites on import.
    beraterNr?: string
    mandantenNr?: string
  }
  startDate: Date
  endDate: Date
  // The list of normalized Buchungssätze. Each one
  // maps to ONE DATEV data line.
  buchungen: BuchungsSatz[]
  // Sequential counter per calendar year per
  // Berater-Mandant. The Berater's DATEV client keys
  // on this for duplicate detection — if the same
  // Buchungslauf is re-imported, DATEV complains.
  // We default to "1" so a manual export without a
  // stored counter still produces a valid file. A
  // cron-driven export would persist + increment a
  // counter in `Company.settings.datev.laufNr` to
  // avoid collisions.
  buchungsLaufNr?: number
  // Eröffnungsbuchungen — opening balances for SKR03
  // accounts that are carried into the new fiscal year.
  // In DATEV terminology, these are "EB-Werte" (Eröffnungs-
  // bilanzwerte) and go on the FIRST Buchungslauf of the
  // year, dated 01.01. Typically one line per
  // Bilanzkonto with the Soll/Haben-Vz matching the
  // natural balance. The Berater's DATEV client uses
  // these to seed the new-year Saldenliste. We
  // prepend these to the regular Buchungen in the
  // generator so the caller's `buchungen` array can
  // stay clean.
  openingBalances?: OpeningBuchungsSatz[]
}

/**
 * Opening balance (Eröffnungsbuchung) for a single
 * SKR03 account. These go on Buchungslauf 1 of the
 * year, dated 01.01. The S/H-Vz encodes the side:
 * "S" = Soll (positive balance on konto — typical
 * for assets, expenses, receivables), "H" = Haben
 * (typical for liabilities, equity, payables).
 */
export interface OpeningBuchungsSatz {
  // 4-digit SKR03 account number
  konto: string
  // Positive amount in EUR
  betrag: number
  // "S" = Soll, "H" = Haben
  shVz: 'S' | 'H'
  // Free-text reason (e.g. "EB-Wert 2026", "Saldo
  // aus 2025 übernommen")
  buchungstext: string
}

export interface BuchungsSatz {
  // Identity
  belegdatum: Date
  belegfeld1: string       // Belegfeld 1 — invoice number / voucher number
  // Belegfeld 2 (optional): the Belegnummer for
  // Voucher-sourced lines. The Berater can use it to
  // reconcile the DATEV row against the Buchungsbeleg
  // in the GoBD audit trail.
  belegfeld2?: string
  // Account side
  konto: string            // Soll-Konto (4 digits)
  gegenkonto: string       // Haben-Konto
  // Amount: positive = Soll on konto / Haben on gegenkonto
  // The DATEV field "Umsatz" is always positive. The
  // S/H-Vz ("Soll-/Haben-Kennzeichen") flips the sign
  // semantically. We default to "S" (Soll) which is the
  // common case for revenue.
  betrag: number
  shVz?: 'S' | 'H'
  // Text
  buchungstext: string
  // Optional fields
  kost1?: string           // Kostenstelle 1 (DATEV column 12)
  kost2?: string           // Kostenträger  (DATEV column 13)
  // VAT (skr03 standard)
  ustSchluessel?: string   // 0/1/2/3 (steuerfrei/0/7/19)
  ustBetrag?: number
  // Currency (DATEV column 16 = Währungskürzel, column 17 = Kurs).
  // Defaults to "EUR" + "1.0000" — only set differently for
  // foreign-currency invoices. The Berater's DATEV client
  // typically auto-derives EUR ↔ home-currency when
  // currency = EUR, so non-EUR values get the explicit
  // rate so the import doesn't guess.
  currency?: string
  exchangeRate?: number
  // Payment method (DATEV column 14 — "Zahlungsweg"). Free
  // text but DATEV imports typically recognise "Bank",
  // "Bar", "SEPA", "Lastschrift", "Kreditkarte". Empty
  // means "not specified" which is fine.
  paymentMethod?: string
  // Optional: 3-digit ISO country code (DATEV column 21).
  // Used for EU/Non-EU transactions to support reverse
  // charge and IgE logic on the DATEV side.
  countryCode?: string
}

function pad(s: string | number, len: number, align: 'left' | 'right' = 'left'): string {
  const str = String(s)
  if (str.length >= len) return str.substring(0, len)
  const pad = ' '.repeat(len - str.length)
  return align === 'right' ? pad + str : str + pad
}

function fmtDecimal(n: number): string {
  // DATEV uses dot as decimal separator, no thousands.
  // Negative numbers are written with leading "-".
  const rounded = Math.round(n * 100) / 100
  return rounded.toFixed(2)
}

function fmtDate(d: Date): string {
  // DDMM (no year). DATEV combines day+month with the
  // period header so the year doesn't need to be in
  // every row.
  return pad(d.getDate().toString(), 2, 'right') + pad((d.getMonth() + 1).toString(), 2, 'right')
}

function csvEscape(s: string): string {
  if (!s) return ''
  // DATEV quote convention: double the inner quotes, wrap
  // in quotes only if the field contains the delimiter
  // (which text fields almost always will).
  if (s.includes(DELIM) || s.includes(QUOTE) || s.includes('\n') || s.includes('\r')) {
    return QUOTE + s.replace(new RegExp(QUOTE, 'g'), QUOTE + QUOTE) + QUOTE
  }
  return s
}

/**
 * Map a country name (as it appears in the Customer /
 * Supplier `address.country` field) to its ISO 3166-1
 * alpha-3 code. DATEV column 21 ("ISO-Ländercode") needs
 * the 3-letter form ("DEU", "AUT", "CHE", "CHN"…).
 *
 * This is a best-effort mapping covering the common
 * German addresses — there's no canonical mapping in
 * the existing schema. Unknown values return "" (DATEV
 * accepts blank, the user can fill in by hand if the
 * row is non-EU).
 */
function mapCountryToIso3(country?: string | null): string {
  if (!country) return ''
  // Normalize: trim + lowercase for the lookup.
  const key = country.trim().toLowerCase()
  const m: Record<string, string> = {
    // DE
    'deutschland': 'DEU',
    'germany': 'DEU',
    'de': 'DEU',
    'deu': 'DEU',
    // EU
    'österreich': 'AUT',
    'austria': 'AUT',
    'at': 'AUT',
    'aut': 'AUT',
    'schweiz': 'CHE',
    'switzerland': 'CHE',
    'ch': 'CHE',
    'che': 'CHE',
    'frankreich': 'FRA',
    'france': 'FRA',
    'fr': 'FRA',
    'fra': 'FRA',
    'italien': 'ITA',
    'italy': 'ITA',
    'it': 'ITA',
    'ita': 'ITA',
    'niederlande': 'NLD',
    'netherlands': 'NLD',
    'nl': 'NLD',
    'nld': 'NLD',
    'belgien': 'BEL',
    'belgium': 'BEL',
    'be': 'BEL',
    'bel': 'BEL',
    'luxemburg': 'LUX',
    'luxembourg': 'LUX',
    'lu': 'LUX',
    'lux': 'LUX',
    'polen': 'POL',
    'poland': 'POL',
    'pl': 'POL',
    'pol': 'POL',
    'tschechien': 'CZE',
    'czechia': 'CZE',
    'czech republic': 'CZE',
    'cz': 'CZE',
    'cze': 'CZE',
    'spanien': 'ESP',
    'spain': 'ESP',
    'es': 'ESP',
    'esp': 'ESP',
    'portugal': 'PRT',
    'pt': 'PRT',
    'prt': 'PRT',
    'dänemark': 'DNK',
    'denmark': 'DNK',
    'dk': 'DNK',
    'dnk': 'DNK',
    'schweden': 'SWE',
    'sweden': 'SWE',
    'se': 'SWE',
    'swe': 'SWE',
    'finnland': 'FIN',
    'finland': 'FIN',
    'fi': 'FIN',
    'fin': 'FIN',
    'irland': 'IRL',
    'ireland': 'IRL',
    'ie': 'IRL',
    'irl': 'IRL',
    // Non-EU (DATEV column 21 is also relevant for these —
    // Drittland case)
    'usa': 'USA',
    'united states': 'USA',
    'vereinigte staaten': 'USA',
    'us': 'USA',
    'großbritannien': 'GBR',
    'grossbritannien': 'GBR',
    'united kingdom': 'GBR',
    'uk': 'GBR',
    'gb': 'GBR',
    'gbr': 'GBR',
    'china': 'CHN',
    'cn': 'CHN',
    'chn': 'CHN',
    'türkei': 'TUR',
    'turkey': 'TUR',
    'tr': 'TUR',
    'tur': 'TUR',
    'russland': 'RUS',
    'russia': 'RUS',
    'ru': 'RUS',
    'rus': 'RUS',
  }
  return m[key] || ''
}

/**
 * Generate a complete DATEV Buchungsstapel CSV string.
 * Returned as ASCII (Windows-1252 compatible — strings are
 * kept to 7-bit safe; umlauts get transliterated because
 * the receiving DATEV client typically expects Latin-1).
 */
export function generateDatevBuchungsstapel(input: DatevExportInput): string {
  const { company, startDate, endDate, buchungen, buchungsLaufNr, openingBalances } = input
  const laufNr = buchungsLaufNr ?? 1

  // The opening balances (EB-Werte) go on Buchungslauf
  // 1, dated 01.01 of the start year. They PRECEDE
  // the regular Buchungen in the CSV because DATEV
  // clients process rows in order and EB-Werte are
  // always the first lines of the year.
  //
  // For EB-Werte the Gegenkonto is the "Eröffnungs-
  // bilanzkonto" (SKR03: 9000 / "Eröffnungsbilanz" or
  // SKR04: 9008). Using a Bilanzkonto as Gegenkonto
  // keeps the Soll/Haben balanced and the S/H-Vz
  // signal correct. In practice, DATEV clients ignore
  // the Gegenkonto on EB-Werte and read the S/H-Vz
  // directly to seed the Saldenliste, so we use the
  // canonical "Erlöffnungsbilanz" account 9000 as
  // placeholder.
  const EB_GEGENKONTO = '9000' // SKR03 Eröffnungsbilanzkonto
  const openingRows: BuchungsSatz[] = (openingBalances || []).map((eb) => ({
    // EB-Werte always sit on 01.01 of the start year
    // (or 01.01 of the year BEFORE the start year, if
    // the start is a fiscal-year boundary). We pick
    // the first day of the year covering startDate.
    belegdatum: new Date(startDate.getFullYear(), 0, 1),
    // "EB-<account>" as Belegfeld 1 so the DATEV client
    // can pivot the row back to the account.
    belegfeld1: `EB-${eb.konto}`,
    konto: eb.konto,
    gegenkonto: EB_GEGENKONTO,
    betrag: eb.betrag,
    shVz: eb.shVz,
    buchungstext: eb.buchungstext,
  }))

  // Header line: 25 fields, all quoted, semicolon-separated.
  // The DATEV EXTF-Format reserves header column 5
  // ("Anwendungsinformation") for application-defined
  // free text. We use it to embed the Buchungslauf
  // number so the Berater's DATEV client can show
  // "Lauf N" alongside the import. The same number
  // appears in the filename and is what DATEV keys
  // on for duplicate detection.
  const header = [
    'EXTF',                                                       // 1  Version
    'Buchungsstapel',                                              // 2  Format
    '15',                                                          // 3  Format version
    'de-invoice Export',                                          // 4  Applikation
    csvEscape(`Lauf ${String(laufNr).padStart(3, '0')}`),         // 5  Anwendungsinformation (Buchungslauf)
    company.beraterNr || '00000',                                  // 6  Berater-Nr
    company.mandantenNr || '00001',                                // 7  Mandanten-Nr
    pad((startDate.getFullYear() - 1).toString(), 4, 'right') + '1231', // 8  WJ-Beginn
    '4',                                                          // 9  Sachkontenlänge
    pad(startDate.getDate().toString(), 2, 'right')
      + pad((startDate.getMonth() + 1).toString(), 2, 'right')
      + pad(startDate.getFullYear().toString(), 4, 'right'),    // 10 Datum von
    pad(endDate.getDate().toString(), 2, 'right')
      + pad((endDate.getMonth() + 1).toString(), 2, 'right')
      + pad(endDate.getFullYear().toString(), 4, 'right'),      // 11 Datum bis
    csvEscape(company.name),                                       // 12 Bezeichnung
    '',                                                            // 13 Diktatkürzel
    '0',                                                           // 14 Buchungstyp
    '0',                                                           // 15 Rechnungs-/Belegnummer
    'EUR',                                                         // 16 Währung
    '',                                                            // 17
    '0',                                                           // 18 Skip header line for Berater-Nr
    '',                                                            // 19
    'SKR03',                                                       // 20 Kontenplan
    csvEscape(company.taxId || ''),                                // 21 Steuernummer
    '',                                                            // 22
    '',                                                            // 23
    '',                                                            // 24
    '',                                                            // 25
  ].join(DELIM)

  // Data lines — opening balances (Buchungslauf 0) +
  // regular Buchungen (Buchungslauf N). The CSV row
  // order matters: EB-Werte first, then the period
  // activity. DATEV processes them in order.
  const data = [...openingRows, ...buchungen].map((b) => {
    return [
      // DATEV columns (32 per row, fields after the
      // required ones can be empty)
      'EXTF',                                  // 1  Kennzeichen
      pad(b.belegdatum.getFullYear().toString(), 4, 'right')
        + fmtDate(b.belegdatum),               // 2  Belegdatum (YYYYDDMM)
      pad(b.belegfeld1, 36),                   // 3  Belegfeld 1 (invoice#)
      pad(b.belegfeld2 || '', 36),              // 4  Belegfeld 2 (voucher# for BankReconciliation/BankTransaction lines)
      csvEscape(b.buchungstext),                // 5  Buchungstext
      b.shVz || 'S',                           // 6  Soll-/Haben-Kennzeichen
      b.konto,                                  // 7  Konto
      b.gegenkonto,                             // 8  Gegenkonto
      fmtDecimal(b.betrag),                     // 9  Umsatz
      '',                                       // 10
      '',                                       // 11
      b.ustSchluessel || '',                    // 12 USt-Schlüssel
      b.ustBetrag !== undefined ? fmtDecimal(b.ustBetrag) : '', // 13 USt-Betrag
      b.paymentMethod || '',                    // 14 Zahlungsweg
      '',                                       // 15 Fälligkeit (skipped — use Payment Date as Belegdatum)
      b.currency || 'EUR',                      // 16 Währung
      // DATEV column 17 (Kurs). Required for non-EUR
      // transactions — the Berater's client refuses
      // to import a non-EUR row without it. We
      // default to "1,0000" when the user hasn't
      // provided an explicit exchangeRate. The 4-digit
      // precision matches the EZB/EBC daily-rounding
      // convention.
      b.exchangeRate !== undefined
        ? b.exchangeRate.toFixed(4).replace('.', ',')
        : '1,0000', // 17 Kurs
      b.kost1 || '',                            // 18 Kostenstelle 1
      b.kost2 || '',                            // 19 Kostenträger
      '',                                       // 20
      b.countryCode || '',                      // 21 ISO-Ländercode (3-stellig)
      '',                                       // 22
      '',                                       // 23
      '',                                       // 24
      '',                                       // 25
      '',                                       // 26
      '',                                       // 27
      '',                                       // 28
      '',                                       // 29
      '',                                       // 30
      '',                                       // 31
      '',                                       // 32
    ].join(DELIM)
  })

  return [header, ...data].join('\r\n') + '\r\n'
}

/**
 * Convenience: build the Buchungsstapel from the in-app
 * data sources (Invoice for revenue, Expense for input
 * tax / cost). Pulled out of the controller so it's
 * unit-testable without a Prisma handle.
 *
 * Account mapping is read from `Company.settings.datev`,
 * falling back to `SKR03_DEFAULTS` for any missing field.
 * A company can override any subset of the 13 accounts
 * (e.g. just the revenue accounts, or just the bank
 * account) without having to re-enter the whole map.
 */
export async function buildBuchungenFromDb(
  prisma: PrismaService,
  companyId: string,
  startDate: Date,
  endDate: Date,
): Promise<BuchungsSatz[]> {
  // Read the per-company override. We `findUnique` rather
  // than passing the company in because that way the
  // service signature stays the same and the e2e tests
  // don't have to fabricate a company object.
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { settings: true },
  })
  const settings = (company?.settings && typeof company.settings === 'object')
    ? (company.settings as any)
    : {}
  const accounts = resolveDatevAccounts(settings.datev)
  // ECB rate snapshot for this company. Pulled
  // once and threaded into every non-EUR row in
  // the invoice + expense passes below. null if
  // the cron hasn't run yet — getRate falls back
  // to "1,0000" so the export still works.
  const rateSnapshot = (settings as any).datev?.exchangeRates ?? null

  const out: BuchungsSatz[] = []

  // 1) Revenue side: paid invoices only (DATEV bucht
  // Erlöse typischerweise bei Zahlungseingang, nicht
  // bei Rechnungserstellung — "Ist-Versteuerung" §18
  // UStG-Variante, the Berater can switch to Soll-
  // Versteuerung via filter).
  //
  // If the invoice is linked to a bank-import voucher
  // (voucherRefId != null), the cash-settlement line
  // (Bank → Forderung) is emitted by the Voucher pass
  // below — we skip it here to avoid double-counting.
  // The Erlöse + USt lines stay on the Invoice side
  // because the Voucher doesn't know the revenue /
  // VAT breakdown.
  const paidInvoices = await prisma.invoice.findMany({
    where: {
      companyId,
      status: 'paid',
      issueDate: { gte: startDate, lte: endDate },
      type: { in: ['INV', 'PI'] },
    },
    include: {
      payments: { orderBy: { paymentDate: 'asc' } },
      voucherRef: { select: { voucherNumber: true } },
      // Customer address — DATEV column 21 (country code)
      // is read off the customer's country for the
      // EU/non-EU split when reverse-charge applies.
      customer: { select: { address: true } },
    },
  })

  for (const inv of paidInvoices) {
    const net = Number(inv.subtotal)
    const vat = Number(inv.totalVat)
    const total = Number(inv.total)
    const vatRate = net > 0 ? vat / net : 0
    const hasVoucher = !!inv.voucherRefId
    const voucherNumber = inv.voucherRef?.voucherNumber
    // Currency + country code + payment method are
    // captured per-invoice so the DATEV export reflects
    // multi-currency and EU/non-EU splits without the
    // user having to edit anything by hand. The
    // countryCode comes from the customer's address
    // (mapped to ISO 3166-1 alpha-3) — required for
    // reverse-charge (§13b) and IgE logic on the
    // DATEV side.
    const currency = inv.currency || 'EUR'
    const paymentMethod = inv.payments[0]?.paymentMethod
    const customerAddress = (inv.customer as any)?.address
    const countryCode = mapCountryToIso3(customerAddress?.country)
    // The exchange rate is read from the
    // per-company ECB snapshot (see
    // ExchangeRateService). EUR doesn't need a
    // rate; for any other currency we look up
    // Company.settings.datev.exchangeRates.rates
    // and fall back to "1,0000" if the cron
    // hasn't run yet. The string is parsed with
    // Number() — ECB returns 4-5 significant
    // digits, which fits in a Number without loss.
    const rateString = currency === 'EUR'
      ? undefined
      : rateSnapshot?.rates?.[currency]
    const rateNum = rateString ? Number(rateString) : undefined
    const exchangeRate = (rateNum && !isNaN(rateNum)) ? rateNum : undefined
    // Kostenstelle 1 + Kostenträger. Read from the
    // Invoice header so the user can stamp the same
    // cost center on every line in the multi-line
    // invoice. DATEV columns 12 + 13. The Prisma
    // optional returns `string | null` but the
    // BuchungsSatz type expects `string | undefined`
    // — `?? undefined` is the cleanest normalisation.
    const kost1 = inv.costCenter ?? undefined
    const kost2 = inv.costObject ?? undefined

    // Pick the revenue account by VAT rate. For an
    // IgE invoice (we sell to an EU business with
    // valid VAT-ID) §1a UStG says: the customer self-
    // assesses VAT, so the invoice is 0% net-only.
    // The revenue lands on the dedicated "Erlöse
    // igL" account (SKR03 default 8125) and NO USt
    // line is emitted — the Berater's DATEV client
    // pivots on account 8125 to populate the ZM
    // (Zusammenfassende Meldung) automatically.
    //
    // For a §13b reverse-charge outgoing invoice
    // (we're the supplier, supplying construction or
    // a non-EU service etc.), the same net-only logic
    // applies. SKR03 doesn't have a dedicated
    // "Erlöse §13b" account by default; we re-use
    // revenue0 / a per-company override. The Berater
    // remaps to a specific account in the datev-
    // config if needed.
    const isIgE = (inv as any).euTransaction === true
    const isRC = (inv as any).reverseCharge === true
    const revenueKonto =
      isIgE ? accounts.revenue0
      : Math.abs(vatRate - 0.19) < 0.001 ? accounts.revenue19
      : Math.abs(vatRate - 0.07) < 0.001 ? accounts.revenue7
      : accounts.revenue0
    // USt-Schlüssel: DATEV column 12. "0" = steuerfrei
    // (used for IgE / §13b / reverse-charge / Kleinunternehmer).
    // "2" = 7%, "3" = 19% USt. The 0-case is the one
    // that triggers the UStVA "steuerfreie Umsätze" row
    // in the Berater's UStVA export.
    const ustSchluessel =
      isIgE || isRC ? '0'
      : Math.abs(vatRate - 0.19) < 0.001 ? '3'
      : Math.abs(vatRate - 0.07) < 0.001 ? '2'
      : '0'
    const vatKonto =
      Math.abs(vatRate - 0.19) < 0.001 ? accounts.vatPayable19
      : accounts.vatPayable7

    // Buchung 1: Bank an Forderung (Zahlungseingang)
    // SKIPPED when the invoice is linked to a
    // bank-import voucher (the Voucher pass below
    // emits the 1200/1406 line).
    if (!hasVoucher) {
      out.push({
        belegdatum: inv.payments[0]?.paymentDate || inv.issueDate,
        belegfeld1: inv.invoiceNumber,
         konto: accounts.bank,
         gegenkonto: accounts.receivable,
         betrag: total,
         shVz: 'S',
         buchungstext: `Zahlungseingang ${inv.invoiceNumber}`,
         currency,
         exchangeRate,
         paymentMethod,
         countryCode,
         kost1,
         kost2,
       })
     }

    // Buchung 2: Forderung an Erlöse (Storno der offenen
    // Forderung bei Zahlung). Single line, splits into
    // net + VAT.
    if (net > 0) {
      out.push({
        belegdatum: inv.payments[0]?.paymentDate || inv.issueDate,
        belegfeld1: inv.invoiceNumber,
        // The Belegfeld 2 is the voucher number when
        // the cash side is on the Voucher pass. The
        // Berater can pivot the revenue row to the
        // Buchungsbeleg via the voucher number.
        belegfeld2: hasVoucher ? voucherNumber : undefined,
        konto: accounts.receivable,
        gegenkonto: revenueKonto,
        betrag: net,
        shVz: 'H',
        buchungstext: `Erlöse ${inv.invoiceNumber}`,
        ustSchluessel,
        // For IgE/RC we still want ustBetrag=0 on the
        // row so the UStVA export sees a "steuerfrei"
        // line with 0 EUR USt — this is how DATEV
        // distinguishes "steuerfreier Umsatz nach
        // §1a UStG" (line 41) from "steuerfreier
        // Umsatz nach §4 UStG" (line 43).
        ustBetrag: isIgE || isRC ? 0 : vat,
        currency,
        exchangeRate,
        paymentMethod,
        countryCode,
        kost1,
        kost2,
      })
      // USt-Buchung
      // SKIPPED for IgE and §13b reverse-charge
      // invoices — the customer self-assesses VAT
      // (or there is no VAT), so we don't book a
      // USt payable. The Berater's DATEV client picks
      // up the steuerfreien Umsatz from the USt-
      // Schlüssel "0" + revenue0 (8125) account.
      // The Zusammenfassende Meldung (ZM) is
      // populated from the EU sales lines (those
      // with countryCode set on the customer).
      if (vat > 0 && !isIgE && !isRC) {
        out.push({
          belegdatum: inv.payments[0]?.paymentDate || inv.issueDate,
          belegfeld1: inv.invoiceNumber,
          belegfeld2: hasVoucher ? voucherNumber : undefined,
          konto: accounts.receivable,
          gegenkonto: vatKonto,
          betrag: vat,
          shVz: 'H',
          buchungstext: `USt ${inv.invoiceNumber}`,
          ustSchluessel,
          ustBetrag: vat,
          currency,
          exchangeRate,
          paymentMethod,
          countryCode,
          kost1,
          kost2,
        })
      }
    }
  }

  // 2) Cost side: booked expenses (§15 UStG Vorsteuer)
  const expenses = await prisma.expense.findMany({
    where: {
      companyId,
      invoiceDate: { gte: startDate, lte: endDate },
      status: { in: ['booked', 'deductible'] },
    },
    include: {
      // The supplier's address — the country here
      // drives the ISO-Ländercode (DATEV column 21)
      // for IgE / reverse-charge supplier invoices.
      // We don't strictly need this when the expense
      // row already has isIntraEU / isReverseCharge
      // set, but it makes the countryCode field
      // available even if the flags are missing.
      supplier: { select: { address: true } },
    },
  })

  for (const exp of expenses) {
    const net = Number(exp.netAmount)
    const vat = Number(exp.vatAmount)
    const total = Number(exp.grossAmount)
    const vatRate = net > 0 ? vat / net : 0
    const isReverseCharge = exp.isReverseCharge
    const isIntraEU = exp.isIntraEU
    // Reverse-charge (§13b UStG) and IgE
    // (innergemeinschaftlicher Erwerb, §1a UStG)
    // both use the "without USt" net amount. The VAT
    // gets booked separately on the
    // inputVatReverseCharge or inputVatIgE account
    // (DATEV standard SKR03: 5810/5811) and the
    // countryCode drives the IgE separate
    // declarations.
    const currency = (exp as any).currency || 'EUR'
    // Exchange rate: same lookup as on invoices.
    // The rateSnapshot is read once per row from
    // the same Company.settings.datev.exchangeRates
    // map. EUR short-circuits.
    const expRateString = currency === 'EUR'
      ? undefined
      : rateSnapshot?.rates?.[currency]
    const expRateNum = expRateString ? Number(expRateString) : undefined
    const exchangeRate = (expRateNum && !isNaN(expRateNum)) ? expRateNum : undefined
    // Supplier's country — drives the ISO-Ländercode
    // for IgE / reverse-charge supplier invoices.
    // Read off supplier.address (where the customer
    // country mapping is). Falls back to "" when no
    // supplier is linked (e.g. an internal-only
    // expense).
    const supplierAddress = (exp.supplier as any)?.address
    const countryCode = mapCountryToIso3(supplierAddress?.country)
    const paymentMethod = (exp as any).paymentMethod
    // Kostenstelle 1 + Kostenträger from the expense
    // header. Same DATEV-column 12 + 13 as on invoices.
    // The Expense model doesn't have its own
    // supplier-country field — the supplier's country
    // is read off the Supplier.address if needed. For
    // the IgE countryCode flow, we look up the
    // Supplier.address.country. The `supplier` include
    // is added below.
    const kost1 = (exp as any).costCenter ?? undefined
    const kost2 = (exp as any).costObject ?? undefined
    const ustSchluessel =
      isReverseCharge ? '0'  // DATEV: 0 = steuerfrei (we'll also auto-book Vorsteuer from reverse-charge side)
      : isIntraEU ? '0'      // §1a UStG = steuerfrei mit Vorsteuerabzug
      : Math.abs(vatRate - 0.19) < 0.001 ? '3'
      : Math.abs(vatRate - 0.07) < 0.001 ? '2'
      : '0'

    const inputVatKonto =
      isIntraEU ? accounts.inputVatIgE
      : isReverseCharge ? accounts.inputVatReverseCharge
      : Math.abs(vatRate - 0.19) < 0.001 ? accounts.inputVat19
      : Math.abs(vatRate - 0.07) < 0.001 ? accounts.inputVat7
      : ''

    const expenseKonto = accounts.expenseDefault

    // Buchung 1: Bank an Aufwand (Zahlungsausgang)
    out.push({
      belegdatum: exp.invoiceDate,
      belegfeld1: exp.invoiceNumber || `EXP-${exp.id.substring(0, 8)}`,
      konto: accounts.bank,
      gegenkonto: expenseKonto,
      betrag: total,
      shVz: 'H',
      buchungstext: exp.description.substring(0, 60),
      currency,
      exchangeRate,
      paymentMethod,
      countryCode,
      kost1,
      kost2,
    })

    // Buchung 2: Vorsteuer an Aufwand
    // Reverse-charge (§13b): the supplier didn't charge
    // USt, but we (the Leistungsempfänger) owe VAT
    // ourselves. The DATEV-side convention: one row
    // Vorsteuer→Aufwand on account 5810 (DATEV USt-VZ
    // reverses the same line on the UStVA). For IgE
    // (§1a) the convention is the same with account
    // 5811. For "normal" domestic input tax we use
    // 1406 (Vorsteuer 19%) / 1407 (Vorsteuer 7%).
    //
    // The German Vorsteuerabzug logik depends on the
    // supplier VAT-ID being VIES-validated BEFORE the
    // date the IgE/RC line is booked. We book the line
    // regardless — the Berater's DATEV client
    // cross-checks the VAT-ID and complains at import
    // time if the validation is missing.
    if (vat > 0) {
      out.push({
        belegdatum: exp.invoiceDate,
        belegfeld1: exp.invoiceNumber || `EXP-${exp.id.substring(0, 8)}`,
        konto: inputVatKonto || accounts.inputVat19,
        gegenkonto: expenseKonto,
        betrag: vat,
        shVz: 'S',
        buchungstext: `Vorsteuer ${exp.invoiceNumber || ''}`.trim(),
        ustSchluessel,
        ustBetrag: vat,
        currency,
        exchangeRate,
        paymentMethod,
        countryCode,
        kost1,
        kost2,
      })
    }
  }

  // 3) Voucher pass: emit one DATEV row per VoucherLine
  // on every posted Voucher in the date range. This is
  // the new source of truth for the cash side of
  // bank-imported transactions. The Invoice pass above
  // already skipped the 1200/1406 cash line for
  // voucher-linked invoices, so there's no double-
  // count.
  //
  // Belegfeld 1 = the Voucher number (the Belegnummer
  // the Berater references in the audit trail).
  // Belegfeld 2 = the linked invoice number for
  // BankReconciliation rows (so the Berater can pivot
  // back to the AR invoice) or the bank-transaction id
  // for BankTransaction expense rows.
  const vouchers = await prisma.voucher.findMany({
    where: {
      companyId,
      date: { gte: startDate, lte: endDate },
      status: 'posted',
    },
    include: {
      // For a Storno-Buchung (referenceType =
      // VoucherReversal), the `reversedBy` relation
      // points back to the original voucher it
      // corrects. We need the original's voucherNumber
      // for Belegfeld 2 so the Berater can pivot the
      // Storno line back to the original Beleg in the
      // DATEV audit trail.
      reversedBy: { select: { voucherNumber: true } },
      lines: { include: { account: { select: { accountNumber: true } } }, orderBy: { sortOrder: 'asc' } },
    },
    orderBy: { date: 'asc' },
  })

  for (const v of vouchers) {
    // For a multi-line Voucher, we emit one DATEV row
    // per line. With 2 lines, this gives 2 rows that
    // share the same Belegdatum + Belegfeld 1 — the
    // Berater pivots on Belegfeld 1 to see them as a
    // pair (the Soll and Haben sides of the same
    // booking).
    for (const line of v.lines) {
      const debit = Number(line.debit)
      const credit = Number(line.credit)
      if (debit === 0 && credit === 0) continue
      // Exactly one of debit/credit is non-zero per
      // line in well-formed data, but be defensive
      // against the double-zero edge case.
      const isDebit = debit > 0
      const amount = isDebit ? debit : credit
      if (amount <= 0) continue
      // Find the "other side" of this Voucher — the
      // sum of the other line(s) on the same Voucher.
      // For a 2-line Voucher (the common case) the
      // Gegenkonto is the other line's account. For
      // more complex Vouchers, the DATEV CSV doesn't
      // really support N-way splits in one row, so we
      // emit one row per line with the Gegenkonto
      // pointing at the first "opposite" line.
      const counterpartLine = v.lines.find(
        (l) => l.id !== line.id
          && (isDebit ? Number(l.credit) > 0 : Number(l.debit) > 0)
      )
      if (!counterpartLine) continue  // skip unbalanced lines

      out.push({
        belegdatum: v.date,
        belegfeld1: v.voucherNumber,
        // Belegfeld 2: the audit pivot field.
        // - BankReconciliation rows link to the
        //   originating invoice number (handled by
        //   the Invoice pass via Belegfeld 2 stamp;
        //   we keep the referenceType label here as
        //   a fallback so the Berater can filter
        //   by source).
        // - VoucherReversal (Storno) rows link to
        //   the ORIGINAL voucher number so the
        //   Berater can pivot from any Storno line
        //   back to the original Beleg in DATEV.
        //   Without this, a Storno looks like a
        //   mysterious new posting in the export.
        belegfeld2: v.reversedBy
          ? v.reversedBy.voucherNumber
          : (v.referenceType || undefined),
        konto: line.account.accountNumber,
        gegenkonto: counterpartLine.account.accountNumber,
        betrag: amount,
        shVz: isDebit ? 'S' : 'H',
        buchungstext: (line.description || v.description || '').substring(0, 60),
        // VAT on the line (rare for cash postings, but
        // possible if the user books a 3-line Voucher
        // with a separate VAT line).
        ustSchluessel: line.vatRate !== null && line.vatRate !== undefined
          ? (Math.abs(Number(line.vatRate) - 0.19) < 0.001 ? '3'
            : Math.abs(Number(line.vatRate) - 0.07) < 0.001 ? '2'
            : '0')
          : undefined,
        ustBetrag: line.vatAmount !== null && line.vatAmount !== undefined
          ? Number(line.vatAmount)
          : undefined,
      })
    }
  }

  return out
}

/**
 * One Beleg-Bild entry. The bundle endpoint zips the
 * matching PDF (or image, or whatever) into the
 * archive under `Belegbilder/<belegfeld1>.<ext>`. The
 * Berater's DATEV client reads the bundle and matches
 * the file to the CSV row via the Belegfeld1 key.
 */
export interface BelegBild {
  // The "key" the Berater uses to match the file to
  // a CSV row — for an invoice line this is the
  // invoice number (Belegfeld 1 of the Erlöse row);
  // for a voucher line it's the voucher number.
  belegfeld1: string
  // Where the PDF lives in our local storage. The
  // path is RELATIVE to the storage root
  // (StorageService.localPath). The bundle endpoint
  // resolves it against the localPath and streams
  // the bytes into the zip.
  relativePath: string
  // What produced the file — used for the
  // <Belegbilder>/index.json so the Berater can
  // pivot by source. Currently we only emit
  // 'invoice' and 'expense' (Voucher has no
  // pdfPath field yet). When a future Voucher.pdfPath
  // is added, the collector re-activates and
  // 'voucher' joins the union.
  source: 'invoice' | 'expense'
}

/**
 * Collect the list of PDFs that should accompany
 * the DATEV Buchungsstapel CSV. The Berater's DATEV
 * client takes the bundle (CSV + Belegbilder folder)
 * and matches each PDF to a CSV row by Belegfeld 1.
 *
 * Without this the Berater has to re-upload every
 * PDF manually — a major pain point.
 *
 * We walk the same date range as the CSV and pull:
 *   - every Invoice in the range with a PDF (revenue side)
 *   - every Expense with an attachmentPath in the range (cost side)
 *
 * Duplicate belegfeld1s (e.g. an invoice + a credit
 * note with the same number — should never happen
 * because the @unique constraint protects us, but
 * just in case) are de-duplicated, first-wins.
 */
export async function collectBelegbilder(
  prisma: PrismaService,
  companyId: string,
  startDate: Date,
  endDate: Date,
): Promise<BelegBild[]> {
  const out: BelegBild[] = []
  const seen = new Set<string>()

  // 1) Invoices with a PDF.
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId,
      // Match the same date range as the CSV. We use
      // issueDate so the user gets the PDF for the
      // invoice they issued in this period, regardless
      // of when it was paid.
      issueDate: { gte: startDate, lte: endDate },
      pdfPath: { not: null },
    },
    select: {
      invoiceNumber: true,
      pdfPath: true,
    },
  })
  for (const inv of invoices) {
    if (!inv.pdfPath || seen.has(inv.invoiceNumber)) continue
    seen.add(inv.invoiceNumber)
    out.push({
      belegfeld1: inv.invoiceNumber,
      relativePath: inv.pdfPath,
      source: 'invoice',
    })
  }

  // 2) Vouchers with their own PDF. NOTE: the
  // current Voucher model has no pdfPath column
  // (the bank-import flow stores the source MT940
  // text in the BankStatement's `rawContent` field,
  // not as a PDF attachment). If we add a Voucher.pdfPath
  // later this block re-activates. The bundle
  // endpoint still works fine for invoices alone.
  // const vouchers = await prisma.voucher.findMany({
  //   where: {
  //     companyId,
  //     date: { gte: startDate, lte: endDate },
  //     status: 'posted',
  //     pdfPath: { not: null },
  //   },
  //   select: {
  //     voucherNumber: true,
  //     pdfPath: true,
  //   },
  // })
  // for (const vch of vouchers) {
  //   if (!vch.pdfPath || seen.has(vch.voucherNumber)) continue
  //   seen.add(vch.voucherNumber)
  //   out.push({
  //     belegfeld1: vch.voucherNumber,
  //     relativePath: vch.pdfPath,
  //     source: 'voucher',
  //   })
  // }

  // 3) Expenses with an attachment (legacy: single
  // attachmentPath string). The new Attachment
  // model (1:N) is the canonical source; we read
  // it in step 4. The legacy column is kept for
  // back-compat with rows that predate the
  // Attachment migration.
  const expenses = await prisma.expense.findMany({
    where: {
      companyId,
      invoiceDate: { gte: startDate, lte: endDate },
      attachmentPath: { not: null },
    },
    select: {
      id: true,
      invoiceNumber: true,
      attachmentPath: true,
    },
  })
  for (const exp of expenses) {
    if (!exp.attachmentPath) continue
    // Expenses don't always have a clean invoice
    // number. Fall back to EXP-<id8> so the file
    // still gets a unique name in the zip.
    const key = exp.invoiceNumber || `EXP-${exp.id.substring(0, 8)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      belegfeld1: key,
      relativePath: exp.attachmentPath,
      source: 'expense',
    })
  }

  // 4) Attachments (1:N) — the canonical Beleg-Bild
  // source for Expenses + Vouchers. Every upload
  // via the ReceiptsPanel in the UI lands in
  // Attachment rows; we walk them by entityType
  // and group by parent (so a single Expense with
  // 3 scans shows up as 3 separate files in the
  // zip, each named <expenseNumber>-<originalName>).
  //
  // We filter attachments to those whose parent
  // Expense/Voucher falls in the date range — the
  // Attachment itself doesn't carry a date, so we
  // have to do a two-step query: pull the parent
  // IDs by date range, then pull attachments whose
  // entityId is in that set.
  const expenseIds = await prisma.expense.findMany({
    where: {
      companyId,
      invoiceDate: { gte: startDate, lte: endDate },
    },
    select: { id: true, invoiceNumber: true },
  })
  const expenseIdToNumber = new Map(
    expenseIds.map((e) => [e.id, e.invoiceNumber]),
  )
  if (expenseIdToNumber.size > 0) {
    const expenseAttachments = await prisma.attachment.findMany({
      where: {
        companyId,
        entityType: 'expense',
        entityId: { in: Array.from(expenseIdToNumber.keys()) },
      },
      select: {
        id: true,
        originalName: true,
        storagePath: true,
        entityId: true,
      },
    })
    for (const att of expenseAttachments) {
      if (!att.storagePath) continue
      const expKey =
        expenseIdToNumber.get(att.entityId) || `EXP-${att.entityId.substring(0, 8)}`
      // The Attachment.originalName is the user's
      // upload name. We suffix it to the belegfeld1
      // so multiple attachments on the same Expense
      // don't collide in the zip:
      //   "INV-2026-0001-receipt.pdf"
      //   "INV-2026-0001-contract.pdf"
      // sanitizeFilename in the controller drops
      // any chars that aren't Windows-safe.
      const ext = att.storagePath.split('.').pop() || 'pdf'
      const safeName = att.originalName.replace(/\.[^.]+$/, '') || 'beleg'
      const key = `${expKey}__${safeName}.${ext}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        belegfeld1: key,
        relativePath: att.storagePath,
        source: 'expense',
      })
    }
  }

  // 5) Voucher attachments (the receipt that came
  // with a manual voucher, e.g. a scanned paper
  // receipt that the user typed up by hand).
  const voucherIds = await prisma.voucher.findMany({
    where: {
      companyId,
      date: { gte: startDate, lte: endDate },
      status: 'posted',
    },
    select: { id: true, voucherNumber: true },
  })
  const voucherIdToNumber = new Map(
    voucherIds.map((v) => [v.id, v.voucherNumber]),
  )
  if (voucherIdToNumber.size > 0) {
    const voucherAttachments = await prisma.attachment.findMany({
      where: {
        companyId,
        entityType: 'voucher',
        entityId: { in: Array.from(voucherIdToNumber.keys()) },
      },
      select: {
        id: true,
        originalName: true,
        storagePath: true,
        entityId: true,
      },
    })
    for (const att of voucherAttachments) {
      if (!att.storagePath) continue
      const vchKey =
        voucherIdToNumber.get(att.entityId) || `VCH-${att.entityId.substring(0, 8)}`
      const ext = att.storagePath.split('.').pop() || 'pdf'
      const safeName = att.originalName.replace(/\.[^.]+$/, '') || 'beleg'
      const key = `${vchKey}__${safeName}.${ext}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        belegfeld1: key,
        relativePath: att.storagePath,
        source: 'expense', // reuses the 'expense' source — the
                            // index.json surfaces the type via the
                            // filename prefix
      })
    }
  }

  return out
}
