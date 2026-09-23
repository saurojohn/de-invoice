/**
 * DATEV Buchungsstapel export — the "DATEV-Format" (EXTF) CSV a
 * Steuerberater imports into DATEV Rechnungswesen.
 *
 * Tier 423 rewrote this file. What it produced before could not be imported:
 * a 25-field header of its own design ("EXTF";"Buchungsstapel";"15";…), every
 * data row starting with "EXTF", the amount in column 9, dot decimals — DATEV
 * reads the columns by position, so nothing landed where it belongs. The
 * bookings were wrong as well: only paid invoices were exported, dated on the
 * payment, on the collective account 1406 with the tax booked a second time
 * on its own row; credit notes, partial payments and unpaid invoices were
 * missing; expenses were booked "Bank an Aufwand" at the invoice date whether
 * paid or not; each voucher line was exported once per line (every voucher
 * twice); the tax keys were invented (see datev-ust-schluessel.ts).
 *
 * Format (DATEV-Format, Buchungsstapel, Formatversion 13; the reference is
 * DATEV's own sample file EXTF_Buchungsstapel.csv):
 *   line 1  header, 31 fields: "EXTF";700;21;"Buchungsstapel";13;<created>;;
 *           <Herkunft>;<Exportiert von>;;<Berater>;<Mandant>;<WJ-Beginn>;
 *           <Sachkontenlänge>;<Datum von>;<Datum bis>;<Bezeichnung>;;1;;0;"EUR";…
 *   line 2  the column headings (DATEV_COLUMNS below, 125 columns)
 *   line 3+ one booking per line: amount always positive with a decimal
 *           comma, "S"/"H" relative to Konto, Belegdatum TTMM, texts quoted.
 *   Windows-1252 (the controller encodes), CRLF line ends.
 *
 * Bookings (Soll-Versteuerung — the invoice is booked when it is issued):
 *   invoice      Debitor S  an Erlöskonto, per VAT rate, gross, with the
 *                tax key (DATEV splits off the tax itself)
 *   credit note  the same, H
 *   payment      Bank S an Debitor (each payment on its own date)
 *   expense      Aufwand an Kreditor, gross with the Vorsteuer key; § 13b and
 *                igE net with key 94/91 resp. 19/18 (DATEV books tax and
 *                input tax)
 *   bank payment of an expense (bank import)  Kreditor S an Bank
 *   other vouchers (manual, bank bookings without an expense, Storno)
 *                one row per booking, not one per voucher line
 * Konto holds the Personenkonto / bank, Gegenkonto the Sachkonto the tax key
 * applies to — the layout of DATEV's sample.
 */

import { PrismaService } from '../../prisma/prisma.service';
// Tier 26.3: SKR03 Sachkonten auto-inference from the line description, for
// voucher lines that have no account yet.
import { applyExpenseInference } from './datev-sachkonto-inference';
import { vatRateToUstSchluessel } from './datev-ust-schluessel';
// Tier 409: per-rate amounts after the invoice discount.
import { invoiceTaxBreakdown } from '../invoice/tax-breakdown';
import { normaliseCountry } from '../invoice/ust-behandlung-detector';
import { ensurePersonenkonten, DIVERSE_KREDITOREN } from './datev-personenkonten';
import { NON_CASH_PAYMENT_METHODS } from '../invoice/document-scope';
import { cashBookings } from '../cashbook/cash-bookings';
import { SALES_TYPES } from '../invoice/document-scope'

const DELIM = ';'
const QUOTE = '"'

/** Per-company DATEV account mapping. Stored as
 *  `Company.settings.datev`. Fields the user
 *  doesn't override fall back to SKR03_DEFAULTS via
 *  `resolveDatevAccounts()`. */
export interface DatevAccountMap {
  bank: string
  cash: string
  transit: string
  receivable: string
  payable: string
  revenue19: string
  revenue7: string
  revenue0: string
  revenueExport: string
  revenueExempt: string
  revenue13b: string
  revenueEuServices: string
  revenueThirdCountryServices: string
  revenueKleinunternehmer: string
  vatPayable19: string
  vatPayable7: string
  outputVatIgE: string
  outputVat13b: string
  inputVat19: string
  inputVat7: string
  inputVatIgE: string
  inputVatReverseCharge: string
  expenseDefault: string
}

/** SKR03 defaults. The Berater can override any of them per company.
 *  Tier 423 corrected the tax accounts: 1760 is "Umsatzsteuer nicht fällig",
 *  not USt 7 % (1771); 1577 is Vorsteuer § 13b, not Vorsteuer 7 % (1571);
 *  1780 / 1782 are the Umsatzsteuer-Vorauszahlungen, not § 13b / igE (1577 /
 *  1574, with the tax owed on 1787 / 1774). With the tax keys DATEV picks
 *  these accounts itself; here they only label the Buchungsliste. */
export const SKR03_DEFAULTS: DatevAccountMap = {
  bank: '1200',                 // Bank
  cash: '1000',                 // Kasse (Tier 425)
  transit: '1360',              // Geldtransit (Tier 434)
  receivable: '1406',           // Forderungen aus L+L (the bank import's vouchers use it too)
  payable: '1600',              // Verbindlichkeiten aus L+L (Sammelkonto der Kreditoren)
  revenue19: '8400',            // Erlöse 19 % USt (Automatikkonto)
  revenue7: '8300',             // Erlöse 7 % USt (Automatikkonto)
  revenue0: '8125',             // steuerfreie innergemeinschaftliche Lieferungen § 4 Nr. 1b
  revenueExport: '8120',        // steuerfreie Umsätze § 4 Nr. 1a (Ausfuhr)
  revenueExempt: '8100',        // steuerfreie Umsätze § 4 Nr. 8 ff.
  revenue13b: '8337',           // Erlöse, Leistungsempfänger schuldet die Steuer (§ 13b)
  revenueEuServices: '8336',    // sonstige Leistungen, im anderen EU-Land steuerpflichtig
  revenueThirdCountryServices: '8338', // im Drittland steuerbare Leistungen
  revenueKleinunternehmer: '8195', // Erlöse als Kleinunternehmer (§ 19 UStG)
  vatPayable19: '1776',         // Umsatzsteuer 19 %
  vatPayable7: '1771',          // Umsatzsteuer 7 %
  outputVatIgE: '1774',         // Umsatzsteuer aus igE 19 %
  outputVat13b: '1787',         // Umsatzsteuer nach § 13b 19 %
  inputVat19: '1576',           // abziehbare Vorsteuer 19 %
  inputVat7: '1571',            // abziehbare Vorsteuer 7 %
  inputVatIgE: '1574',          // abziehbare Vorsteuer aus igE 19 %
  inputVatReverseCharge: '1577', // abziehbare Vorsteuer nach § 13b 19 %
  expenseDefault: '4900',       // sonstige betriebliche Aufwendungen
}

/** Merge a partial per-company config over the SKR03 defaults. */
export function resolveDatevAccounts(overrides: Partial<DatevAccountMap> | null | undefined): DatevAccountMap {
  if (!overrides) return { ...SKR03_DEFAULTS }
  return { ...SKR03_DEFAULTS, ...overrides }
}

/** Type guard: pick valid numeric account numbers
 *  out of an arbitrary user-submitted object. */
export function sanitizeDatevConfig(input: any): Partial<DatevAccountMap> {
  if (!input || typeof input !== 'object') return {}
  const out: Partial<DatevAccountMap> = {}
  for (const k of Object.keys(SKR03_DEFAULTS) as (keyof DatevAccountMap)[]) {
    const v = input[k]
    if (typeof v === 'string' && /^\d{3,5}$/.test(v)) {
      out[k] = v.padEnd(4, '0').substring(0, 5)
    }
  }
  return out
}

export interface DatevExportInput {
  company: {
    id?: string
    name: string
    taxId?: string | null
    // DATEV Beraternummer (1001–9999999) and Mandantennummer (1–99999), as
    // the Berater hands them to the client. Missing or out of range: 1001 / 1,
    // which the Berater overwrites on import.
    beraterNr?: string
    mandantenNr?: string
  }
  startDate: Date
  endDate: Date
  buchungen: BuchungsSatz[]
  // Written into the header's Anwendungsinformation ("Lauf 001") so the
  // Berater can tell exports apart.
  buchungsLaufNr?: number
  // Eröffnungsbuchungen (EB-Werte), prepended to the bookings.
  openingBalances?: OpeningBuchungsSatz[]
  // Wirtschaftsjahr-Beginn; defaults to 1 January of the start year.
  fiscalYearStart?: Date
}

/**
 * Opening balance (Eröffnungsbuchung) for a single account, booked against
 * the Eröffnungsbilanzkonto 9000.
 */
export interface OpeningBuchungsSatz {
  konto: string
  betrag: number
  shVz: 'S' | 'H'
  buchungstext: string
}

export interface BuchungsSatz {
  belegdatum: Date
  belegfeld1: string       // invoice / voucher number
  belegfeld2?: string      // e.g. the invoice a payment settles
  konto: string            // Personenkonto, bank, … ("S"/"H" refers to it)
  gegenkonto: string       // the Sachkonto; the tax key applies to it
  betrag: number           // EUR, positive (a negative amount flips S/H)
  shVz?: 'S' | 'H'
  buchungstext: string
  kost1?: string
  kost2?: string
  ustSchluessel?: string   // DATEV BU-Schlüssel, '' = none
  // The tax contained in betrag (DATEV splits it off via the key) and the
  // account it lands on — only for the Buchungsliste / USt-Verprobung.
  ustBetrag?: number
  steuerKonto?: string
  // Customer's / supplier's VAT id for an igL / igE / EU § 13b booking
  // (DATEV column "EU-Land u. USt-IdNr.", feeds the ZM).
  euUstId?: string
  // Kept on the row for information; the amounts are always in EUR.
  currency?: string
  exchangeRate?: number
  paymentMethod?: string
  countryCode?: string
}

/** The column headings of a DATEV Buchungsstapel, Formatversion 13. */
export const DATEV_COLUMNS: string[] = [
  'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basisumsatz',
  'WKZ Basisumsatz', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum',
  'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext', 'Postensperre', 'Diverse Adressnummer',
  'Geschäftspartnerbank', 'Sachverhalt', 'Zinssperre', 'Beleglink',
  ...Array.from({ length: 8 }, (_, i) => [`Beleginfo – Art ${i + 1}`, `Beleginfo – Inhalt ${i + 1}`]).flat(),
  'KOST1 – Kostenstelle', 'KOST2 – Kostenstelle', 'Kost Menge', 'EU-Land u. USt-IdNr.', 'EU-Steuersatz',
  'Abw. Versteuerungsart', 'Sachverhalt L+L', 'Funktionsergänzung L+L', 'BU 49 Hauptfunktionstyp',
  'BU 49 Hauptfunktionsnummer', 'BU 49 Funktionsergänzung',
  ...Array.from({ length: 20 }, (_, i) => [`Zusatzinformation – Art ${i + 1}`, `Zusatzinformation – Inhalt ${i + 1}`]).flat(),
  'Stück', 'Gewicht', 'Zahlweise', 'Forderungsart', 'Veranlagungsjahr', 'Zugeordnete Fälligkeit',
  'Skontotyp', 'Auftragsnummer', 'Buchungstyp', 'USt-Schlüssel (Anzahlungen)', 'EU-Mitgliedstaat (Anzahlungen)',
  'Sachverhalt L+L (Anzahlungen)', 'EU-Steuersatz (Anzahlungen)', 'Erlöskonto (Anzahlungen)', 'Herkunft-Kz',
  'Leerfeld', 'KOST-Datum', 'SEPA-Mandatsreferenz', 'Skontosperre', 'Gesellschaftername', 'Beteiligtennummer',
  'Identifikationsnummer', 'Zeichnernummer', 'Postensperre bis', 'Bezeichnung', 'Kennzeichen',
  'Festschreibung', 'Leistungsdatum', 'Datum Zuord.', 'Fälligkeit', 'Generalumkehr', 'Steuersatz', 'Land',
  'Abrechnungsreferent', 'BVV-Position', 'EU-Mitgliedstaat u. UStID (Ursprung)', 'EU-Steuersatz (Ursprung)',
  'Abw. Skontokonto',
]
const COL = (name: string) => {
  const i = DATEV_COLUMNS.indexOf(name)
  if (i < 0) throw new Error(`DATEV column ${name}`)
  return i
}

const r2 = (n: number) => Math.round(n * 100) / 100
const fmtAmount = (n: number) => r2(n).toFixed(2).replace('.', ',')
const dd = (n: number) => String(n).padStart(2, '0')
// Dates are stored as midnight UTC; read them in UTC so a booking never moves
// to the previous day.
const ymd = (d: Date) => `${d.getUTCFullYear()}${dd(d.getUTCMonth() + 1)}${dd(d.getUTCDate())}`
const ttmm = (d: Date) => `${dd(d.getUTCDate())}${dd(d.getUTCMonth() + 1)}`

/** A quoted DATEV text field: inner quotes doubled, line breaks removed,
 *  cut to the field's length. */
function text(s: string | undefined | null, max: number): string {
  const v = String(s ?? '').replace(/[\r\n]+/g, ' ').substring(0, max)
  return QUOTE + v.replace(/"/g, '""') + QUOTE
}
/** Belegfeld 1/2 allow only letters, digits and $ & % * + - / (max 36). */
const beleg = (s: string | undefined | null) => (s ? text(String(s).replace(/[^A-Za-z0-9$&%*+\-/]/g, ''), 36) : '')

function normVatId(vatId?: string | null): string {
  return (vatId || '').replace(/\s+/g, '').toUpperCase()
}

/**
 * Generate a complete DATEV Buchungsstapel. The controller encodes the string
 * as Windows-1252.
 */
export function generateDatevBuchungsstapel(input: DatevExportInput): string {
  const { company, startDate, endDate, buchungen, buchungsLaufNr, openingBalances } = input
  const laufNr = buchungsLaufNr ?? 1

  const EB_GEGENKONTO = '9000' // SKR03 Saldenvorträge Sachkonten
  const openingRows: BuchungsSatz[] = (openingBalances || []).map((eb) => ({
    belegdatum: new Date(Date.UTC(startDate.getUTCFullYear(), 0, 1)),
    belegfeld1: `EB-${eb.konto}`,
    konto: eb.konto,
    gegenkonto: EB_GEGENKONTO,
    betrag: eb.betrag,
    shVz: eb.shVz,
    buchungstext: eb.buchungstext,
  }))

  const berater = Number(company.beraterNr)
  const mandant = Number(company.mandantenNr)
  const now = new Date()
  const created = ymd(now) + dd(now.getUTCHours()) + dd(now.getUTCMinutes()) + dd(now.getUTCSeconds())
    + String(now.getUTCMilliseconds()).padStart(3, '0')
  const wjBeginn = input.fiscalYearStart ?? new Date(Date.UTC(startDate.getUTCFullYear(), 0, 1))
  const header = [
    '"EXTF"', '700', '21', '"Buchungsstapel"', '13', created,
    '',                                           // importiert
    '"RE"',                                       // Herkunft
    '"de-invoice"',                               // exportiert von
    '',                                           // importiert von
    String(berater >= 1001 && berater <= 9999999 ? berater : 1001),
    String(mandant >= 1 && mandant <= 99999 ? mandant : 1),
    ymd(wjBeginn),
    '4',                                          // Sachkontenlänge
    ymd(startDate), ymd(endDate),
    text(company.name, 30),                       // Bezeichnung
    '',                                           // Diktatkürzel
    '1',                                          // Buchungstyp: Finanzbuchführung
    '',                                           // Rechnungslegungszweck
    '0',                                          // Festschreibung: nein
    '"EUR"',
    '', '', '', '', '', '', '', '',
    text(`Lauf ${String(laufNr).padStart(3, '0')}`, 16), // Anwendungsinformation
  ].join(DELIM)

  const cBelegdatum = COL('Belegdatum')
  const data = [...openingRows, ...buchungen]
    .filter((b) => r2(b.betrag) !== 0)
    .map((b) => {
      const f: string[] = new Array(DATEV_COLUMNS.length).fill('')
      const negative = b.betrag < 0
      const sh = b.shVz === 'H' ? 'H' : 'S'
      f[COL('Umsatz (ohne Soll/Haben-Kz)')] = fmtAmount(Math.abs(b.betrag))
      f[COL('Soll/Haben-Kennzeichen')] = QUOTE + (negative ? (sh === 'S' ? 'H' : 'S') : sh) + QUOTE
      f[COL('Konto')] = b.konto
      f[COL('Gegenkonto (ohne BU-Schlüssel)')] = b.gegenkonto
      if (b.ustSchluessel) f[COL('BU-Schlüssel')] = QUOTE + b.ustSchluessel + QUOTE
      f[cBelegdatum] = ttmm(b.belegdatum)
      f[COL('Belegfeld 1')] = beleg(b.belegfeld1)
      f[COL('Belegfeld 2')] = beleg(b.belegfeld2)
      f[COL('Buchungstext')] = text(b.buchungstext, 60)
      if (b.kost1) f[COL('KOST1 – Kostenstelle')] = text(b.kost1, 36)
      if (b.kost2) f[COL('KOST2 – Kostenstelle')] = text(b.kost2, 36)
      if (b.euUstId) f[COL('EU-Land u. USt-IdNr.')] = text(normVatId(b.euUstId), 15)
      return f.join(DELIM)
    })

  return [header, DATEV_COLUMNS.join(DELIM), ...data].join('\r\n') + '\r\n'
}

// Windows-1252 has these in 0x80–0x9F, where Latin-1 has control codes.
const CP1252_EXTRA: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89,
  'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
}
/** The bytes of a DATEV file: Windows-1252, anything it cannot hold as "?".
 *  (Buffer's 'latin1' turned the "–" of DATEV's column headings and every "€"
 *  into control characters; some paths wrote UTF-8.) */
export function encodeDatevCsv(csv: string): Buffer {
  const out = Buffer.alloc(csv.length)
  let n = 0
  for (const ch of csv) {
    const c = ch.codePointAt(0)!
    out[n++] = CP1252_EXTRA[ch] ?? (c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : 0x3f)
  }
  return out.subarray(0, n)
}

const EU = ['DE', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']
const isEU = (c: string) => EU.includes(c.toUpperCase())

/** The revenue account for a zero-rated amount — the same classification as
 *  the UStVA (ustva.service addZeroRated), so the export and the
 *  Voranmeldung agree. euUstId is set when the booking belongs in the ZM. */
function zeroRatedRevenue(
  a: DatevAccountMap,
  flags: { euTransaction?: boolean | null; reverseCharge?: boolean | null },
  country: string,
  vatId: string,
): { konto: string; zm: boolean } {
  const germanVatId = vatId.toUpperCase().startsWith('DE')
  if (flags.euTransaction === true) return { konto: a.revenue0, zm: true }
  if (flags.reverseCharge === true) {
    if (country && country !== 'DE' && isEU(country)) return { konto: a.revenueEuServices, zm: true }
    if (country && !isEU(country)) return { konto: a.revenueThirdCountryServices, zm: false }
    return { konto: a.revenue13b, zm: false }
  }
  if (!germanVatId && country && isEU(country) && country !== 'DE' && vatId) return { konto: a.revenue0, zm: true }
  if (country && !isEU(country)) return { konto: a.revenueExport, zm: false }
  return { konto: a.revenueExempt, zm: false }
}

const same = (a: number, b: number) => Math.abs(a - b) < 0.001

/**
 * Build the Buchungssätze for a period from the app's data.
 *
 * Personenkonten are assigned here on first use (datev-personenkonten.ts).
 */
export async function buildBuchungenFromDb(
  prisma: PrismaService,
  companyId: string,
  startDate: Date,
  endDate: Date,
): Promise<BuchungsSatz[]> {
  // Tier 431: an end date given as a day ("2026-09-30", parsed to 00:00 UTC)
  // covers that whole day. A payment recorded at 14:00 on the last day of
  // the period fell outside it — and the next period starts the day after,
  // so it was in no export at all.
  if (
    endDate.getUTCHours() === 0 && endDate.getUTCMinutes() === 0 &&
    endDate.getUTCSeconds() === 0 && endDate.getUTCMilliseconds() === 0
  ) {
    endDate = new Date(endDate.getTime() + 86_400_000 - 1)
  }
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { settings: true, defaultVatMode: true },
  })
  const settings = (company?.settings && typeof company.settings === 'object')
    ? (company.settings as any)
    : {}
  const a = resolveDatevAccounts(settings.datev)
  const kleinunternehmer = company?.defaultVatMode === 'kleinunternehmer'

  const out: BuchungsSatz[] = []

  // ── 1. Invoices and credit notes, at their issue date ─────────────────
  // Proforma invoices (PI) are not invoices and are not booked.
  const documents = await prisma.invoice.findMany({
    where: {
      companyId,
      issueDate: { gte: startDate, lte: endDate },
      status: { in: ['sent', 'paid', 'overdue'] }, // as the UStVA
      type: { in: SALES_TYPES }, // Tier 424: Quittungen too
    },
    include: {
      items: { select: { quantity: true, unitPrice: true, vatRate: true } },
      customer: { select: { id: true, address: true, vatId: true } },
      referenceInvoice: { select: { invoiceNumber: true, euTransaction: true, reverseCharge: true } },
    },
    orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
  })

  // Payments in the period, on any invoice (the invoice may be older).
  const payments = await prisma.payment.findMany({
    where: {
      paymentDate: { gte: startDate, lte: endDate },
      // Credit notes (and the Skonto) are booked as credit notes above; the
      // synthetic payment that records them on the original is not cash —
      // nor is a customer credit applied to an invoice (Tier 431).
      paymentMethod: { notIn: NON_CASH_PAYMENT_METHODS },
      invoice: { companyId, type: { in: ['INV', 'CN'] }, status: { notIn: ['draft', 'cancelled'] } },
    },
    include: {
      invoice: {
        select: { invoiceNumber: true, customerId: true, currency: true, subtotal: true, eurSubtotal: true },
      },
    },
    orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
  })

  const debitoren = await ensurePersonenkonten(prisma, 'customer', companyId, [
    ...documents.map((d) => d.customerId),
    ...payments.map((p) => p.invoice.customerId),
  ])
  const debitor = (customerId: string) => String(debitoren.get(customerId) ?? a.receivable)

  // Non-EUR documents are booked in EUR: at the rate stored on the document
  // (eurSubtotal, fixed at issue), else at the company's ECB snapshot
  // (foreign units per EUR), else 1:1. The export used to write the foreign
  // amount as it was, with the rate in a column of its own layout.
  const ecb = (settings.datev?.exchangeRates?.rates ?? {}) as Record<string, string>
  const eurFactor = (inv: { subtotal: any; eurSubtotal: any; currency?: string | null }) => {
    if (!inv.currency || inv.currency === 'EUR') return 1
    if (inv.eurSubtotal != null && Number(inv.subtotal)) {
      const f = Number(inv.eurSubtotal) / Number(inv.subtotal)
      if (isFinite(f) && f > 0) return f
    }
    const rate = Number(ecb[inv.currency])
    return isFinite(rate) && rate > 0 ? 1 / rate : 1
  }

  for (const doc of documents) {
    const isCN = doc.type === 'CN'
    const flags = isCN ? (doc.referenceInvoice ?? {}) : doc
    const country = normaliseCountry((doc.customer as any)?.address?.country) || ''
    const vatId = (doc.customer as any)?.vatId || ''
    const f = eurFactor(doc)
    const text = isCN
      ? `Gutschrift ${doc.invoiceNumber}${doc.referenceInvoice ? ` zu ${doc.referenceInvoice.invoiceNumber}` : ''}`
      : `Rechnung ${doc.invoiceNumber}`
    for (const bucket of invoiceTaxBreakdown(doc).byRate) {
      // A credit note's buckets are negative: H on the Debitor.
      const gross = r2((bucket.net + bucket.vat) * f)
      if (gross === 0) continue
      const vat = r2(bucket.vat * f)
      let gegenkonto: string
      let key = ''
      let steuerKonto: string | undefined
      let euUstId: string | undefined
      if (kleinunternehmer) {
        gegenkonto = a.revenueKleinunternehmer
      } else if (bucket.rate > 0 && !(flags as any).euTransaction && !(flags as any).reverseCharge) {
        const is19 = same(bucket.rate, 0.19)
        gegenkonto = is19 ? a.revenue19 : same(bucket.rate, 0.07) ? a.revenue7 : a.revenue19
        key = vatRateToUstSchluessel(bucket.rate, 'output')?.key
          ?? vatRateToUstSchluessel(bucket.rate, 'legacy')?.key ?? ''
        steuerKonto = same(bucket.rate, 0.07) ? a.vatPayable7 : a.vatPayable19
      } else {
        const z = zeroRatedRevenue(a, flags as any, country, vatId)
        gegenkonto = z.konto
        if (z.zm && vatId) euUstId = vatId
      }
      out.push({
        belegdatum: doc.issueDate,
        belegfeld1: doc.invoiceNumber,
        belegfeld2: isCN ? doc.referenceInvoice?.invoiceNumber : undefined,
        konto: debitor(doc.customerId),
        gegenkonto,
        betrag: gross,
        shVz: 'S',
        buchungstext: text,
        ustSchluessel: key,
        ustBetrag: key ? vat : 0,
        steuerKonto,
        euUstId,
        kost1: doc.costCenter ?? undefined,
        kost2: doc.costObject ?? undefined,
        currency: doc.currency || 'EUR',
        countryCode: country,
      })
    }
  }

  for (const p of payments) {
    const amount = r2(Number(p.amount) * eurFactor(p.invoice))
    out.push({
      belegdatum: p.paymentDate,
      belegfeld1: p.receiptNumber || p.invoice.invoiceNumber,
      belegfeld2: p.invoice.invoiceNumber,
      // Tier 425: a Barzahlung (e.g. entered in the Kassenbuch) is Kasse.
      konto: p.paymentMethod === 'cash' ? a.cash : a.bank,
      gegenkonto: debitor(p.invoice.customerId),
      // A payment on a credit note is a refund: negative, so H on the bank.
      betrag: amount,
      shVz: 'S',
      buchungstext: `Zahlung ${p.invoice.invoiceNumber}`,
      paymentMethod: p.paymentMethod,
    })
  }

  // ── 2. Expenses (Eingangsrechnungen), at their invoice date ──────────
  const expenses = await prisma.expense.findMany({
    where: {
      companyId,
      invoiceDate: { gte: startDate, lte: endDate },
      status: { in: ['booked', 'deductible'] },
    },
    include: { supplier: { select: { id: true, vatId: true } } },
    orderBy: { invoiceDate: 'asc' },
  })

  // Vouchers are read now so their suppliers get accounts in the same pass.
  const vouchers = await prisma.voucher.findMany({
    where: { companyId, date: { gte: startDate, lte: endDate }, status: 'posted' },
    include: {
      reversedBy: { select: { voucherNumber: true, referenceType: true, description: true } },
      lines: { include: { account: { select: { accountNumber: true } } }, orderBy: { sortOrder: 'asc' } },
    },
    orderBy: [{ date: 'asc' }, { voucherNumber: 'asc' }],
  })
  const expenseTag = (d?: string | null) => /\[expense:([0-9a-f-]{36})\]/.exec(d || '')?.[1]
  const voucherExpenseIds = vouchers
    .map((v) => expenseTag(v.description) ?? expenseTag(v.reversedBy?.description))
    .filter((x): x is string => !!x)
  const voucherExpenses = voucherExpenseIds.length
    ? await prisma.expense.findMany({
      where: { companyId, id: { in: voucherExpenseIds } },
      select: { id: true, supplierId: true, invoiceNumber: true },
    })
    : []

  const cashPaidExpenses = await prisma.cashBookEntry.findMany({
    where: {
      companyId,
      businessDate: { gte: startDate, lte: endDate },
      type: 'ausgabe',
      expenseId: { not: null },
    },
    include: { expense: { select: { supplierId: true, invoiceNumber: true } } },
    orderBy: { businessDate: 'asc' },
  })
  // Tier 432: expenses paid by other means than the bank import or the cash
  // book — the SEPA credit-transfer run sets `paidAt` — got no payment row,
  // so in DATEV the Kreditor stayed owed while the app (balance sheet, 4000)
  // had it paid. Booked from `paidAt`, unless a bank-import voucher or a
  // cash-book entry already books that payment (below / 2b).
  const paidExpenses = await prisma.expense.findMany({
    where: {
      companyId,
      paidAt: { gte: startDate, lte: endDate },
      status: { in: ['booked', 'deductible'] },
      cashBookEntries: { none: {} },
    },
    select: {
      id: true, supplierId: true, invoiceNumber: true, description: true,
      grossAmount: true, paidAt: true, paidBySepaBatchId: true,
    },
  })
  const bankMatched = paidExpenses.length
    ? await prisma.voucher.findMany({
      where: {
        companyId,
        referenceType: 'Expense',
        OR: paidExpenses.map((e) => ({ description: { contains: `[expense:${e.id}]` } })),
      },
      select: { description: true },
    })
    : []
  const matchedIds = new Set(bankMatched.map((v) => expenseTag(v.description)).filter(Boolean))
  const otherwisePaid = paidExpenses.filter((e) => !matchedIds.has(e.id))

  const kreditoren = await ensurePersonenkonten(prisma, 'supplier', companyId, [
    ...expenses.map((e) => e.supplierId || ''),
    ...voucherExpenses.map((e) => e.supplierId || ''),
    ...cashPaidExpenses.map((e) => e.expense?.supplierId || ''),
    ...otherwisePaid.map((e) => e.supplierId || ''),
  ])
  const kreditor = (supplierId?: string | null) =>
    String((supplierId && kreditoren.get(supplierId)) || DIVERSE_KREDITOREN)

  for (const exp of expenses) {
    const net = Number(exp.netAmount)
    const vat = Number(exp.vatAmount)
    const gross = Number(exp.grossAmount)
    const rate = Number(exp.vatRate)
    const belegfeld1 = exp.invoiceNumber || `EXP-${exp.id.substring(0, 8)}`
    const base = {
      belegdatum: exp.invoiceDate,
      belegfeld1,
      konto: kreditor(exp.supplierId),
      gegenkonto: exp.accountNumber || a.expenseDefault,
      shVz: 'H' as const,
      buchungstext: exp.description.substring(0, 60),
      kost1: (exp as any).costCenter ?? undefined,
      kost2: (exp as any).costObject ?? undefined,
      currency: (exp as any).currency || 'EUR',
    }
    if (!kleinunternehmer && (exp.isIntraEU || exp.isReverseCharge)) {
      // The supplier charged no tax; this company owes it and deducts it.
      // Booked net with the key; a rate of 0 means "not entered" → 19 %
      // (as in the UStVA).
      const r = rate > 0 ? rate : 0.19
      const key = vatRateToUstSchluessel(r, exp.isIntraEU ? 'igE' : 'reverseCharge')?.key ?? ''
      out.push({
        ...base,
        betrag: r2(net),
        ustSchluessel: key,
        ustBetrag: 0, // tax and input tax cancel out
        euUstId: exp.isIntraEU ? exp.supplier?.vatId || undefined : undefined,
      })
    } else if (!kleinunternehmer && vat !== 0) {
      const key = vatRateToUstSchluessel(rate, 'input')?.key ?? ''
      out.push({
        ...base,
        betrag: r2(gross),
        ustSchluessel: key,
        ustBetrag: key ? r2(vat) : 0,
        steuerKonto: same(rate, 0.07) ? a.inputVat7 : a.inputVat19,
      })
    } else {
      // No input tax: a Kleinunternehmer cannot deduct it, or there is none.
      out.push({ ...base, betrag: r2(gross) })
    }
  }

  for (const e of otherwisePaid) {
    out.push({
      belegdatum: e.paidAt!,
      belegfeld1: e.invoiceNumber || `EXP-${e.id.substring(0, 8)}`,
      konto: a.bank,
      gegenkonto: kreditor(e.supplierId),
      betrag: r2(Number(e.grossAmount)),
      shVz: 'H',
      buchungstext: `Zahlung ${e.paidBySepaBatchId ? 'SEPA ' : ''}${e.description}`.substring(0, 60),
    })
  }

  // ── 2b. Kassenbuch (Tier 425) ─────────────────────────────────────
  // Cash sales and purchases of their own (cash-bookings.ts) — in no export
  // before — and the cash payment of a recorded expense (Kreditor an Kasse).
  for (const c of await cashBookings(prisma, companyId, startDate, endDate)) {
    const inbound = c.direction === 'in'
    let gegenkonto: string
    let key = ''
    if (inbound) {
      gegenkonto = kleinunternehmer ? a.revenueKleinunternehmer
        : c.rate === 0 ? a.revenueExempt
        : same(c.rate, 0.07) ? a.revenue7 : a.revenue19
      if (!kleinunternehmer && c.rate > 0) key = vatRateToUstSchluessel(c.rate, 'output')?.key ?? ''
    } else {
      gegenkonto = a.expenseDefault
      if (!kleinunternehmer && c.rate > 0) key = vatRateToUstSchluessel(c.rate, 'input')?.key ?? ''
    }
    out.push({
      belegdatum: c.date,
      belegfeld1: c.belegNumber || `KB-${c.id.substring(0, 8)}`,
      konto: a.cash,
      gegenkonto,
      betrag: c.gross,
      shVz: inbound ? 'S' : 'H',
      buchungstext: c.description.substring(0, 60),
      ustSchluessel: key,
      ustBetrag: key ? c.vat : 0,
      steuerKonto: key
        ? (inbound ? (same(c.rate, 0.07) ? a.vatPayable7 : a.vatPayable19) : (same(c.rate, 0.07) ? a.inputVat7 : a.inputVat19))
        : undefined,
    })
  }
  // Tier 434: a Kassenbuch "Umbuchung" takes cash to the bank. It reached
  // no export. Booked Geldtransit an Kasse (SKR03 1360): the bank side
  // arrives with the bank statement (Bank an Geldtransit), so the deposit is
  // not counted twice when the statement is imported too.
  const transfers = await prisma.cashBookEntry.findMany({
    where: { companyId, businessDate: { gte: startDate, lte: endDate }, type: 'umbuchung' },
    orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
  })
  for (const t of transfers) {
    out.push({
      belegdatum: t.businessDate,
      belegfeld1: t.belegNumber || `KB-${t.id.substring(0, 8)}`,
      konto: a.cash,
      gegenkonto: a.transit,
      betrag: r2(Number(t.amount)),
      shVz: 'H',
      buchungstext: t.description.substring(0, 60),
    })
  }
  for (const e of cashPaidExpenses) {
    out.push({
      belegdatum: e.businessDate,
      belegfeld1: e.belegNumber || e.expense?.invoiceNumber || `KB-${e.id.substring(0, 8)}`,
      belegfeld2: e.expense?.invoiceNumber ?? undefined,
      konto: a.cash,
      gegenkonto: kreditor(e.expense?.supplierId),
      betrag: Number(e.amount),
      shVz: 'H',
      buchungstext: e.description.substring(0, 60),
    })
  }

  // ── 3. Vouchers ────────────────────────────────────────────────────
  // Skipped: vouchers for things booked above — an invoice ('invoice'), a
  // matched bank payment ('BankReconciliation', which also records the
  // Payment) and its reopening — and Storno vouchers of those.
  const SKIP = new Set(['invoice', 'BankReconciliation', 'BankReconciliationReversal'])
  const expenseIdToSupplier = new Map(voucherExpenses.map((e) => [e.id, e]))

  for (const v of vouchers) {
    const origin = v.referenceType === 'VoucherReversal' ? v.reversedBy?.referenceType ?? null : v.referenceType
    if (v.referenceType && SKIP.has(v.referenceType)) continue
    if (origin && SKIP.has(origin)) continue
    const belegfeld2 = v.reversedBy?.voucherNumber

    // Bank payment of a recorded expense: the expense is booked above on
    // the Kreditor; the voucher only settles it — Kreditor S an Bank. (It
    // used to export the voucher's Aufwand and Vorsteuer lines as well,
    // booking the expense a second time.)
    if (origin === 'Expense') {
      const id = expenseTag(v.description) ?? expenseTag(v.reversedBy?.description)
      const exp = id ? expenseIdToSupplier.get(id) : undefined
      const bankOut = v.lines.reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0)
      // bankOut > 0: the payment itself; < 0: its Storno.
      let bank = 0
      for (const l of v.lines) {
        if (l.account?.accountNumber === a.bank) bank += Number(l.credit) - Number(l.debit)
      }
      const amount = r2(bank || bankOut)
      out.push({
        belegdatum: v.date,
        belegfeld1: v.voucherNumber,
        belegfeld2: belegfeld2 ?? exp?.invoiceNumber ?? undefined,
        konto: a.bank,
        gegenkonto: kreditor(exp?.supplierId),
        betrag: amount,
        shVz: 'H',
        buchungstext: (v.description || '').replace(/\s*\[expense:[^\]]*\]/, '').substring(0, 60),
      })
      continue
    }

    // Resolve accounts (Tier 26.3 inference for lines without one).
    type L = { account: string; amount: number; debit: boolean; rate: number; vat: number; text: string; kost1?: string; kost2?: string }
    const lines: L[] = []
    for (const line of v.lines) {
      const debit = Number(line.debit)
      const credit = Number(line.credit)
      const amount = debit - credit
      if (amount === 0) continue
      let acc = line.account?.accountNumber
      if (!acc && line.description) {
        const inferred = await applyExpenseInference(prisma, line.id, line.description)
        if (inferred) {
          const refreshed = await prisma.voucherLine.findUnique({
            where: { id: line.id },
            include: { account: { select: { accountNumber: true } } },
          })
          acc = refreshed?.account?.accountNumber
        }
      }
      if (!acc) continue
      lines.push({
        account: acc,
        amount: Math.abs(amount),
        debit: amount > 0,
        rate: line.vatRate != null ? Number(line.vatRate) : 0,
        vat: line.vatAmount != null ? Number(line.vatAmount) : 0,
        text: line.description || v.description || '',
        kost1: (line as any).costCenter ?? undefined,
        kost2: (line as any).costObject ?? undefined,
      })
    }
    // A tax line (its amount is its own vatAmount) is folded into the
    // largest other line on its side, which then carries the gross amount
    // and the tax key — DATEV splits the tax off again.
    type G = L & { key: string; tax: number }
    const sides: Record<'S' | 'H', G[]> = { S: [], H: [] }
    const taxLines: L[] = []
    for (const l of lines) {
      if (l.rate > 0 && l.vat > 0 && Math.abs(l.amount - l.vat) < 0.005) taxLines.push(l)
      else sides[l.debit ? 'S' : 'H'].push({ ...l, key: '', tax: 0 })
    }
    for (const t of taxLines) {
      const side = sides[t.debit ? 'S' : 'H']
      const target = side.slice().sort((x, y) => y.amount - x.amount)[0]
      if (!target) { sides[t.debit ? 'S' : 'H'].push({ ...t, key: '', tax: 0 }); continue }
      target.amount += t.amount
      target.tax += t.amount
      target.key = vatRateToUstSchluessel(t.rate, t.debit ? 'input' : 'output')?.key ?? ''
    }
    const row = (single: G, other: G, singleSide: 'S' | 'H') => ({
      belegdatum: v.date,
      belegfeld1: v.voucherNumber,
      belegfeld2: belegfeld2 ?? (v.referenceType || undefined),
      konto: single.account,
      gegenkonto: other.account,
      betrag: r2(other.amount),
      shVz: singleSide,
      buchungstext: (other.text || single.text).substring(0, 60),
      ustSchluessel: other.key,
      ustBetrag: r2(other.tax),
      kost1: other.kost1 ?? single.kost1,
      kost2: other.kost2 ?? single.kost2,
    })
    if (sides.S.length === 1 && sides.H.length === 1) {
      // The side carrying the tax key is the Gegenkonto (the key applies to it).
      if (sides.S[0].key && !sides.H[0].key) out.push(row(sides.H[0], sides.S[0], 'H'))
      else out.push(row(sides.S[0], sides.H[0], 'S'))
    } else if (sides.S.length === 1 && sides.H.length > 1) {
      for (const h of sides.H) out.push(row(sides.S[0], h, 'S'))
    } else if (sides.H.length === 1 && sides.S.length > 1) {
      for (const s of sides.S) out.push(row(sides.H[0], s, 'H'))
    } else if (sides.S.length > 1 && sides.H.length > 1) {
      // N:M — no single counter account. Each line against the transit
      // account 1590 (Durchlaufende Posten), which nets to zero.
      const transit: G = { account: '1590', amount: 0, debit: false, rate: 0, vat: 0, text: v.description || '', key: '', tax: 0 }
      for (const s of sides.S) out.push(row(transit, s, 'H'))
      for (const h of sides.H) out.push(row(transit, h, 'S'))
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
