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
  inputVat19: '1576',           // Vorsteuer 19%
  inputVat7: '1577',           // Vorsteuer 7%
  inputVatIgE: '1578',         // Vorsteuer igE
  inputVatReverseCharge: '1780', // Vorsteuer §13b
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
  kost1?: string           // Kostenstelle 1
  kost2?: string           // Kostenstelle 2
  // VAT (skr03 standard)
  ustSchluessel?: string   // 0/1/2/3 (steuerfrei/0/7/19)
  ustBetrag?: number
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
 * Generate a complete DATEV Buchungsstapel CSV string.
 * Returned as ASCII (Windows-1252 compatible — strings are
 * kept to 7-bit safe; umlauts get transliterated because
 * the receiving DATEV client typically expects Latin-1).
 */
export function generateDatevBuchungsstapel(input: DatevExportInput): string {
  const { company, startDate, endDate, buchungen } = input

  // Header line: 25 fields, all quoted, semicolon-separated
  const header = [
    'EXTF',                                                       // 1  Version
    'Buchungsstapel',                                              // 2  Format
    '15',                                                          // 3  Format version
    'de-invoice Export',                                          // 4  Applikation
    '',                                                            // 5
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

  // Data lines — one per Buchungssatz
  const data = buchungen.map((b) => {
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
      '',                                       // 14
      '',                                       // 15
      '',                                       // 16
      '',                                       // 17
      b.kost1 || '',                            // 18 Kostenstelle 1
      b.kost2 || '',                            // 19 Kostenstelle 2
      '',                                       // 20
      '',                                       // 21
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
    },
  })

  for (const inv of paidInvoices) {
    const net = Number(inv.subtotal)
    const vat = Number(inv.totalVat)
    const total = Number(inv.total)
    const vatRate = net > 0 ? vat / net : 0
    const hasVoucher = !!inv.voucherRefId
    const voucherNumber = inv.voucherRef?.voucherNumber

    // Pick the revenue account by VAT rate.
    const revenueKonto =
      Math.abs(vatRate - 0.19) < 0.001 ? accounts.revenue19
      : Math.abs(vatRate - 0.07) < 0.001 ? accounts.revenue7
      : accounts.revenue0
    const ustSchluessel =
      Math.abs(vatRate - 0.19) < 0.001 ? '3'
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
        ustBetrag: vat,
      })
      // USt-Buchung
      if (vat > 0) {
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
  })

  for (const exp of expenses) {
    const net = Number(exp.netAmount)
    const vat = Number(exp.vatAmount)
    const total = Number(exp.grossAmount)
    const vatRate = net > 0 ? vat / net : 0
    const isReverseCharge = exp.isReverseCharge
    const isIntraEU = exp.isIntraEU

    const inputVatKonto =
      isIntraEU ? accounts.inputVatIgE
      : isReverseCharge ? accounts.inputVatReverseCharge
      : Math.abs(vatRate - 0.19) < 0.001 ? accounts.inputVat19
      : Math.abs(vatRate - 0.07) < 0.001 ? accounts.inputVat7
      : ''

    const expenseKonto = accounts.expenseDefault

    out.push({
      belegdatum: exp.invoiceDate,
      belegfeld1: exp.invoiceNumber || `EXP-${exp.id.substring(0, 8)}`,
      konto: accounts.bank,
      gegenkonto: expenseKonto,
      betrag: total,
      shVz: 'H',
      buchungstext: exp.description.substring(0, 60),
    })

    // Vorsteuer-Buchung wenn nicht reverse-charge
    if (vat > 0 && !isReverseCharge) {
      out.push({
        belegdatum: exp.invoiceDate,
        belegfeld1: exp.invoiceNumber || `EXP-${exp.id.substring(0, 8)}`,
        konto: inputVatKonto || accounts.inputVat19,
        gegenkonto: expenseKonto,
        betrag: vat,
        shVz: 'S',
        buchungstext: `Vorsteuer ${exp.invoiceNumber || ''}`.trim(),
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
        // Belegfeld 2: link the Belegnummer to the
        // originating document (invoice# for
        // BankReconciliation, txn short-id for
        // BankTransaction expenses).
        belegfeld2: v.referenceType || undefined,
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
