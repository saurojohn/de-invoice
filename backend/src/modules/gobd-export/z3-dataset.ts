import * as fs from 'fs'
import * as path from 'path'
import { PrismaService } from '../../prisma/prisma.service'
import { buildBuchungenFromDb } from '../reports/datev.service'
import { businessDayIso } from '../../common/business-date'

/**
 * Tier 749 — the data handed over to the tax office, described (Z3).
 *
 * § 147 Abs. 6 AO: the data go to the auditor in a machine-readable form. The
 * tax office's software (IDEA) reads them with the "Beschreibungsstandard": a
 * file index.xml names each table, its columns and their types, and the data
 * are plain text files beside it. The archive held JSON, PDF and one CSV,
 * which the auditor would have had to describe by hand.
 *
 * Text files: UTF-8, `;` between columns, CRLF between rows, text in double
 * quotes, no heading row (the columns are in index.xml), decimal comma,
 * dates DD.MM.YYYY.
 *
 * index.xml names its DTD, gdpdu-01-09-2004.dtd, which has to lie beside it.
 * The DTD is the publisher's (Audicon / Caseware), so it comes into the
 * archive from assets/ when the operator has placed it there, and the report
 * says when it has not.
 */
export const Z3_DTD = 'gdpdu-01-09-2004.dtd'
const DTD_FILE = path.resolve(__dirname, '..', '..', '..', 'assets', Z3_DTD)
/** the DTD the publisher offers, if it is in this installation */
export const z3Dtd = (): Buffer | null => (fs.existsSync(DTD_FILE) ? fs.readFileSync(DTD_FILE) : null)

type ColumnType = 'text' | 'date' | 'num2' | 'num4'
interface Z3Column {
  name: string
  description: string
  type: ColumnType
}
export interface Z3Table {
  file: string
  name: string
  description: string
  /** columns of the primary key: the first ones */
  keys: Z3Column[]
  columns: Z3Column[]
  /** columns of this table → the table they point at */
  foreignKey?: { names: string[]; references: string }
  rows: unknown[][]
}

const text = (name: string, description = name): Z3Column => ({ name, description, type: 'text' })
const date = (name: string, description = name): Z3Column => ({ name, description, type: 'date' })
const money = (name: string, description = name): Z3Column => ({ name, description, type: 'num2' })
const num4 = (name: string, description = name): Z3Column => ({ name, description, type: 'num4' })

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** A value of the books: its German calendar day (date-only values are midnight UTC). */
const dayOf = (d: Date) => businessDayIso(d).split('-').reverse().join('.')
/** The bounds of a period are UTC by construction: 31.12. 23:59:59.999Z is still the 31st. */
const boundOf = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('.')

function cell(value: unknown, type: ColumnType): string {
  if (value === null || value === undefined || value === '') return ''
  if (type === 'date') return dayOf(value instanceof Date ? value : new Date(String(value)))
  if (type === 'text') return `"${String(value).replace(/[\r\n]+/g, ' ').replace(/"/g, '""')}"`
  return Number(value).toFixed(type === 'num2' ? 2 : 4).replace('.', ',')
}

/** One data file: no heading row, every row ending in CRLF. */
export function z3Csv(table: Z3Table): Buffer {
  const columns = [...table.keys, ...table.columns]
  return Buffer.from(table.rows.map((row) => columns.map((c, i) => cell(row[i], c.type)).join(';') + '\r\n').join(''), 'utf8')
}

function columnXml(c: Z3Column, element: 'VariablePrimaryKey' | 'VariableColumn'): string {
  const type =
    c.type === 'date' ? '<Date><Format>DD.MM.YYYY</Format></Date>'
    : c.type === 'text' ? '<AlphaNumeric/>'
    : `<Numeric><Accuracy>${c.type === 'num2' ? 2 : 4}</Accuracy></Numeric>`
  return `<${element}><Name>${xml(c.name)}</Name><Description>${xml(c.description)}</Description>${type}</${element}>`
}

function tableXml(t: Z3Table, from: Date, to: Date): string {
  const fk = t.foreignKey
    ? `<ForeignKey>${t.foreignKey.names.map((n) => `<Name>${xml(n)}</Name>`).join('')}<References>${xml(t.foreignKey.references)}</References></ForeignKey>`
    : ''
  return (
    `<Table><URL>${xml(t.file)}</URL><Name>${xml(t.name)}</Name><Description>${xml(t.description)}</Description>` +
    `<Validity><Range><From>${boundOf(from)}</From><To>${boundOf(to)}</To></Range><Format>DD.MM.YYYY</Format></Validity>` +
    '<UTF8/><DecimalSymbol>,</DecimalSymbol><DigitGroupingSymbol>.</DigitGroupingSymbol>' +
    '<VariableLength><ColumnDelimiter>;</ColumnDelimiter><RecordDelimiter>&#13;&#10;</RecordDelimiter><TextEncapsulator>&quot;</TextEncapsulator>' +
    t.keys.map((c) => columnXml(c, 'VariablePrimaryKey')).join('') +
    t.columns.map((c) => columnXml(c, 'VariableColumn')).join('') +
    fk +
    '</VariableLength></Table>'
  )
}

export function z3IndexXml(input: {
  supplierName: string
  supplierLocation: string
  period: string
  from: Date
  to: Date
  generatedAt: Date
  tables: Z3Table[]
}): string {
  const { supplierName, supplierLocation, period, from, to, generatedAt, tables } = input
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
    `<!DOCTYPE DataSet SYSTEM "${Z3_DTD}">\r\n` +
    '<DataSet><Version>1.0</Version>' +
    `<DataSupplier><Name>${xml(supplierName)}</Name><Location>${xml(supplierLocation || '-')}</Location>` +
    `<Comment>de-invoice, Datenüberlassung ${xml(period)}, erstellt am ${dayOf(generatedAt)}</Comment></DataSupplier>` +
    `<Media><Name>Datenüberlassung ${xml(period)}</Name>` +
    tables.map((t) => tableXml(t, from, to)).join('') +
    '</Media></DataSet>\r\n'
  )
}

/** The tables of a period. `to` is the period's last moment. */
export async function z3Tables(prisma: PrismaService, companyId: string, from: Date, to: Date): Promise<Z3Table[]> {
  const inPeriod = { gte: from, lte: to }
  const [buchungen, accounts, customers, suppliers, invoices, expenses, payments, cash] = await Promise.all([
    buildBuchungenFromDb(prisma, companyId, from, to),
    prisma.account.findMany({ where: { companyId }, orderBy: { accountNumber: 'asc' } }),
    prisma.customer.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
    prisma.supplier.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
    prisma.invoice.findMany({
      where: { companyId, issueDate: inPeriod, status: { not: 'draft' } },
      orderBy: { invoiceNumber: 'asc' },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    }),
    prisma.expense.findMany({
      where: { companyId, invoiceDate: inPeriod },
      orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
      include: { taxLines: { orderBy: { position: 'asc' } }, supplier: { select: { name: true } } },
    }),
    prisma.payment.findMany({
      where: { paymentDate: inPeriod, invoice: { companyId } },
      orderBy: { paymentDate: 'asc' },
      include: { invoice: { select: { invoiceNumber: true } } },
    }),
    prisma.cashBookEntry.findMany({ where: { companyId, businessDate: inPeriod }, orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }] }),
  ])
  const address = (a: unknown) => {
    const x = (a ?? {}) as { street?: string; postalCode?: string; city?: string; country?: string }
    return [x.street, [x.postalCode, x.city].filter(Boolean).join(' '), x.country].filter(Boolean).join(', ')
  }
  return [
    {
      file: 'buchungen.csv',
      name: 'Buchungen',
      description: 'Buchungsjournal des Zeitraums, wie im DATEV-Buchungsstapel',
      keys: [text('Lfd_Nr', 'Laufende Nummer')],
      columns: [
        date('Belegdatum'), text('Belegnummer'), text('Belegfeld_2', 'Bezug, z. B. die bezahlte Rechnung'), text('Konto'), text('Gegenkonto'),
        money('Betrag', 'Betrag in EUR; negativ dreht Soll/Haben'), text('Soll_Haben', 'S oder H, bezogen auf Konto'), text('Steuerschluessel', 'DATEV-BU-Schlüssel'),
        money('Steuerbetrag', 'Im Betrag enthaltene Steuer'), text('Buchungstext'), text('Kostenstelle'), text('USt_IdNr', 'USt-IdNr. des Geschäftspartners'),
      ],
      rows: buchungen.map((b, i) => [
        String(i + 1), b.belegdatum, b.belegfeld1, b.belegfeld2, b.konto, b.gegenkonto,
        b.betrag, b.shVz ?? 'S', b.ustSchluessel, b.ustBetrag, b.buchungstext, b.kost1, b.euUstId,
      ]),
    },
    {
      file: 'konten.csv',
      name: 'Konten',
      description: 'Kontenplan',
      keys: [text('Kontonummer')],
      columns: [text('Bezeichnung'), text('Kontoart'), text('Kategorie')],
      rows: accounts.map((a) => [a.accountNumber, a.name, a.type, a.category]),
    },
    {
      file: 'kunden.csv',
      name: 'Kunden',
      description: 'Stammdaten der Kunden (Debitoren)',
      keys: [text('Kunden_ID', 'Interne Kennung')],
      columns: [text('Kundennummer'), text('Debitorenkonto'), text('Name'), text('USt_IdNr'), text('Anschrift')],
      rows: customers.map((c) => [c.id, c.customerNumber, c.datevAccount, c.name, c.vatId, address(c.address)]),
    },
    {
      file: 'lieferanten.csv',
      name: 'Lieferanten',
      description: 'Stammdaten der Lieferanten (Kreditoren)',
      keys: [text('Lieferanten_ID', 'Interne Kennung')],
      columns: [text('Kreditorenkonto'), text('Name'), text('USt_IdNr'), text('Anschrift')],
      rows: suppliers.map((s) => [s.id, s.datevAccount, s.name, s.vatId, address(s.address)]),
    },
    {
      file: 'rechnungen.csv',
      name: 'Rechnungen',
      description: 'Ausgestellte Dokumente des Zeitraums: Rechnungen, Gutschriften und andere Belegarten',
      keys: [text('Rechnungsnummer')],
      columns: [
        text('Belegart'), text('Status'), date('Rechnungsdatum'), date('Faellig'), text('Kunden_ID'), text('Kunde'),
        money('Netto'), money('Umsatzsteuer'), money('Brutto'), text('Waehrung'), num4('Kurs', 'Umrechnungskurs'),
      ],
      rows: invoices.map((i) => [
        i.invoiceNumber, i.type, i.status, i.issueDate, i.dueDate, i.customerId, i.customerName,
        i.subtotal, i.totalVat, i.total, i.currency, i.exchangeRate,
      ]),
    },
    {
      file: 'rechnungspositionen.csv',
      name: 'Rechnungspositionen',
      description: 'Die Positionen der Dokumente in Rechnungen',
      keys: [text('Rechnungsnummer'), text('Position')],
      columns: [text('Beschreibung'), num4('Menge'), text('Einheit'), num4('Einzelpreis'), num4('Steuersatz', 'Als Bruchteil: 0,19'), money('Netto'), money('Umsatzsteuer'), money('Brutto')],
      foreignKey: { names: ['Rechnungsnummer'], references: 'Rechnungen' },
      rows: invoices.flatMap((i) =>
        i.items.map((it, n) => [i.invoiceNumber, String(n + 1), it.description, it.quantity, it.unit, it.unitPrice, it.vatRate, it.netAmount, it.vatAmount, it.grossAmount]),
      ),
    },
    {
      file: 'zahlungen.csv',
      name: 'Zahlungen',
      description: 'Zahlungseingänge auf Rechnungen im Zeitraum',
      keys: [text('Zahlung_ID', 'Interne Kennung')],
      columns: [text('Rechnungsnummer'), date('Zahldatum'), money('Betrag'), text('Waehrung'), text('Zahlungsart'), text('Referenz')],
      foreignKey: { names: ['Rechnungsnummer'], references: 'Rechnungen' },
      rows: payments.map((p) => [p.id, p.invoice.invoiceNumber, p.paymentDate, p.amount, p.currency, p.paymentMethod, p.reference]),
    },
    {
      file: 'ausgaben.csv',
      name: 'Ausgaben',
      description: 'Eingangsrechnungen und Ausgaben des Zeitraums; die AfA-Buchungen mit ihren Stornos',
      keys: [text('Ausgabe_ID', 'Interne Kennung')],
      columns: [
        text('Rechnungsnummer'), date('Rechnungsdatum'), text('Lieferant'), text('Beschreibung'), text('Kategorie'), text('Sachkonto'),
        money('Netto'), num4('Steuersatz', 'Als Bruchteil; bei mehreren Sätzen der der größten Zeile'), money('Vorsteuer'), money('Brutto'),
        text('Status'), date('Bezahlt_am'), text('Storno_von', 'Kennung der stornierten AfA-Buchung'),
      ],
      rows: expenses.map((e) => [
        e.id, e.invoiceNumber, e.invoiceDate, e.supplier?.name, e.description, e.category, e.accountNumber,
        e.netAmount, e.vatRate, e.vatAmount, e.grossAmount, e.status, e.paidAt, e.reversesExpenseId,
      ]),
    },
    {
      file: 'ausgaben_steuerzeilen.csv',
      name: 'Ausgaben_Steuerzeilen',
      description: 'Eine Zeile je Steuersatz bei Ausgaben mit mehreren Steuersätzen',
      keys: [text('Ausgabe_ID', 'Interne Kennung'), num4('Steuersatz', 'Als Bruchteil: 0,19')],
      columns: [money('Netto'), money('Vorsteuer')],
      foreignKey: { names: ['Ausgabe_ID'], references: 'Ausgaben' },
      rows: expenses.flatMap((e) => e.taxLines.map((l) => [e.id, l.vatRate, l.netAmount, l.vatAmount])),
    },
    {
      file: 'kassenbuch.csv',
      name: 'Kassenbuch',
      description: 'Kassenbuch des Zeitraums; ein Storno steht als eigene Zeile mit negativem Betrag',
      keys: [text('Eintrag_ID', 'Interne Kennung')],
      columns: [date('Geschaeftstag'), text('Art'), text('Beschreibung'), money('Betrag'), num4('Steuersatz', 'Als Bruchteil'), text('Gegenpartei'), text('Belegnummer'), text('Storno_von', 'Kennung des stornierten Eintrags')],
      rows: cash.map((c) => [c.id, c.businessDate, c.type, c.description, c.amount, c.vatRate, c.counterparty, c.belegNumber, c.reversesId]),
    },
  ]
}
