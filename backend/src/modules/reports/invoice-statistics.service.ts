/**
 * Tier 709 — what was invoiced: per month and per year, in amounts and in
 * numbers, and what was sold, in quantities.
 *
 * The owner, 20.10.2026: „发票方面实现每个月和年度能看开出去的金额数据和数量销售功能“.
 * The Umsatzbericht (GET /reports/sales) lists only the months that had an
 * invoice, gives a net total above a table of gross amounts, counts a credit
 * note as one more invoice, and says nothing about quantities.
 *
 * Rules (the UStVA's, as far as they reach here):
 *   - documents: issued invoices and receipts (INV, RCV) and credit notes
 *     (CN) — not drafts, not cancelled ones, not a Proforma, quote, delivery
 *     note or order confirmation;
 *   - a document counts in the month of its issue date; a credit note in its
 *     own month (§ 17 UStG), as a negative amount, and is counted apart;
 *   - amounts in euros, at the rate each document was booked at;
 *   - an invoice cancelled by its Storno credit note (Tier 694) is still one
 *     invoice written (and counted as „storniert“); its amount and the credit
 *     note's cancel out;
 *   - quantities come from the lines of the invoices that stand — a fully
 *     credited one sold nothing. A line's amount is its share of its
 *     invoice's net (after the invoice's discount). Two rows of their own
 *     make the rows add up to the net of the period: the invoices of the
 *     period cancelled by a credit note (+), and the credit notes of the
 *     period (−) — a Storno of a March invoice in October is + in March and
 *     − in October.
 */
import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { coversWhole, CREDITING } from '../invoice/stock'

const r2 = (n: number): number => Math.round(n * 100) / 100
const SOLD_TYPES = ['INV', 'RCV']

export interface StatsFigures {
  invoiceCount: number
  creditNoteCount: number
  cancelledCount: number
  net: number
  vat: number
  gross: number
}

export interface ProductRow {
  key: string
  productId: string | null
  name: string
  unit: string
  quantity: number
  net: number
  invoiceCount: number
}

const empty = (): StatsFigures => ({ invoiceCount: 0, creditNoteCount: 0, cancelledCount: 0, net: 0, vat: 0, gross: 0 })

@Injectable()
export class InvoiceStatisticsService {
  constructor(private readonly prisma: PrismaService) {}

  async statistics(companyId: string, year: number, month?: number) {
    const docs = await this.prisma.invoice.findMany({
      where: {
        companyId,
        type: { in: [...SOLD_TYPES, 'CN'] },
        status: { notIn: ['draft', 'cancelled'] },
        issueDate: { lt: new Date(Date.UTC(year + 1, 0, 1)) },
      },
      select: {
        id: true, type: true, issueDate: true, total: true, totalVat: true, eurTotal: true, eurTotalVat: true,
        creditNotes: { where: CREDITING, select: { total: true } },
      },
    })
    const eurGross = (d: { total: unknown; eurTotal: unknown }) => Number(d.eurTotal ?? d.total ?? 0)
    const eurVat = (d: { totalVat: unknown; eurTotalVat: unknown }) => Number(d.eurTotalVat ?? d.totalVat ?? 0)
    const add = (f: StatsFigures, d: (typeof docs)[number]) => {
      const gross = eurGross(d), vat = eurVat(d)
      if (d.type === 'CN') f.creditNoteCount += 1
      else {
        f.invoiceCount += 1
        if (coversWhole(d, d.creditNotes)) f.cancelledCount += 1
      }
      f.gross += gross
      f.vat += vat
      f.net += gross - vat
    }
    const round = (f: StatsFigures): StatsFigures => ({ ...f, net: r2(f.net), vat: r2(f.vat), gross: r2(f.gross) })

    // the year, month by month (all twelve)
    const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...empty() }))
    const total = empty()
    // the years up to this one
    const byYear = new Map<number, StatsFigures>()
    for (const d of docs) {
      const y = d.issueDate.getUTCFullYear()
      if (!byYear.has(y)) byYear.set(y, empty())
      add(byYear.get(y)!, d)
      if (y === year) {
        add(months[d.issueDate.getUTCMonth()], d)
        add(total, d)
      }
    }
    const firstYear = Math.max(Math.min(...byYear.keys(), year), year - 9)
    const years: Array<StatsFigures & { year: number; netChangePct: number | null }> = []
    for (let y = firstYear; y <= year; y++) {
      const f = round(byYear.get(y) ?? empty())
      const prev = years[years.length - 1]
      years.push({ year: y, ...f, netChangePct: prev && prev.net > 0 ? r2(((f.net - prev.net) / prev.net) * 100) : null })
    }

    const products = await this.products(companyId, year, month, docs)
    return {
      year,
      month: month ?? null,
      total: round(total),
      months: months.map((m) => ({ ...m, ...round(m) })),
      years,
      products,
    }
  }

  /** What was sold in the year (or one month of it), by article — quantities from the lines. */
  private async products(
    companyId: string,
    year: number,
    month: number | undefined,
    docs: Array<{ id: string; type: string; issueDate: Date; total: unknown; totalVat: unknown; eurTotal: unknown; eurTotalVat: unknown; creditNotes: { total: unknown }[] }>,
  ) {
    const inPeriod = (d: Date) => d.getUTCFullYear() === year && (month == null || d.getUTCMonth() + 1 === month)
    const period = docs.filter((d) => inPeriod(d.issueDate))
    const periodNet = r2(period.reduce((s, d) => s + Number(d.eurTotal ?? d.total ?? 0) - Number(d.eurTotalVat ?? d.totalVat ?? 0), 0))
    const standing = period.filter((d) => d.type !== 'CN' && !coversWhole(d, d.creditNotes))
    const lines = standing.length
      ? await this.prisma.invoiceItem.findMany({
          where: { invoiceId: { in: standing.map((d) => d.id) } },
          select: { invoiceId: true, productId: true, description: true, unit: true, quantity: true, netAmount: true, product: { select: { name: true } } },
        })
      : []
    const lineNetOf = new Map<string, number>()
    for (const l of lines) lineNetOf.set(l.invoiceId, (lineNetOf.get(l.invoiceId) ?? 0) + Number(l.netAmount ?? 0))
    const docNet = new Map(standing.map((d) => [d.id, Number(d.eurTotal ?? d.total ?? 0) - Number(d.eurTotalVat ?? d.totalVat ?? 0)]))

    const rows = new Map<string, ProductRow & { invoices: Set<string> }>()
    for (const l of lines) {
      const unit = (l.unit || '').trim() || 'Stück'
      const name = l.product?.name || (l.description || '').trim() || '—'
      const key = l.productId ? `p:${l.productId}:${unit}` : `d:${name.toLowerCase()}:${unit}`
      const sum = lineNetOf.get(l.invoiceId) ?? 0
      const share = sum !== 0 ? Number(l.netAmount ?? 0) / sum : 0
      const row = rows.get(key) ?? { key, productId: l.productId, name, unit, quantity: 0, net: 0, invoiceCount: 0, invoices: new Set<string>() }
      row.quantity += Number(l.quantity ?? 0)
      row.net += (docNet.get(l.invoiceId) ?? 0) * share
      row.invoices.add(l.invoiceId)
      rows.set(key, row)
    }
    const articles: ProductRow[] = [...rows.values()]
      .map(({ invoices, ...r }) => ({ ...r, quantity: Math.round(r.quantity * 10000) / 10000, net: r2(r.net), invoiceCount: invoices.size }))
      .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name, 'de'))
    const netOf = (d: (typeof period)[number]) => Number(d.eurTotal ?? d.total ?? 0) - Number(d.eurTotalVat ?? d.totalVat ?? 0)
    // the invoices of the period cancelled by a credit note (sold nothing) and
    // the credit notes of the period (in their own month) — with the
    // articles, the net of the period
    const cancelledNet = r2(period.filter((d) => d.type !== 'CN' && coversWhole(d, d.creditNotes)).reduce((s, d) => s + netOf(d), 0))
    const creditNotesNet = r2(period.filter((d) => d.type === 'CN').reduce((s, d) => s + netOf(d), 0))
    // the cents the shares leave go to the largest row, so the rows add up exactly
    const rest = r2(periodNet - cancelledNet - creditNotesNet - articles.reduce((s, r) => s + r.net, 0))
    if (articles.length && rest !== 0) articles[0].net = r2(articles[0].net + rest)
    return { rows: articles, cancelledNet, creditNotesNet, net: periodNet }
  }
}
