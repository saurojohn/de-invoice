/**
 * Tier 540 — exchange differences (Kursgewinne / Kursverluste).
 *
 * An invoice in a foreign currency is in the books at the rate of its day
 * (`exchangeRate`, "1 EUR = rate"; `eurTotal`). What arrives later in EUR is
 * a different amount. § 4 Abs. 3 EStG counts what was received; in the
 * double-entry books the difference is income (SKR03 2660) or cost (2150).
 * Until now the reports counted the invoice's rate — 990 € received for a
 * 1 085 USD invoice (1 000 € at its rate) were counted as 1 000 €.
 *
 * The difference is known where the EUR amount is: a payment matched from a
 * EUR bank statement (BankImportService.confirmMatch), or one entered with
 * `eurAmount`. A payment without it stays at the invoice's rate.
 *
 * No VAT moves: the tax base is converted at the rate of the supply
 * (§ 16 Abs. 6 UStG), not of the payment.
 */
type Db = any

const r2 = (n: number) => Math.round(n * 100) / 100

export interface Kursdifferenz {
  paymentId: string
  invoiceId: string
  invoiceNumber: string
  customerId: string | null
  paymentDate: Date
  paymentMethod: string
  currency: string
  /** the payment at the invoice's rate, EUR */
  nominalEur: number
  /** what arrived, EUR */
  eurAmount: number
  /** eurAmount − nominalEur: positive a Kursgewinn, negative a Kursverlust */
  differenz: number
}

/** The payment's amount in EUR at its invoice's rate. */
export function nominalEur(amount: unknown, invoice: { total: unknown; eurTotal: unknown; exchangeRate: unknown }): number {
  const total = Number(invoice.total)
  const eurTotal = Number(invoice.eurTotal)
  if (total && Number.isFinite(eurTotal) && eurTotal) return r2((Number(amount) * eurTotal) / total)
  const rate = Number(invoice.exchangeRate)
  return r2(rate > 0 ? Number(amount) / rate : Number(amount))
}

export async function kursdifferenzen(
  db: Db,
  companyId: string,
  start: Date,
  end: Date,
): Promise<{ gewinn: number; verlust: number; rows: Kursdifferenz[] }> {
  const payments = await db.payment.findMany({
    where: {
      eurAmount: { not: null },
      paymentDate: { gte: start, lte: end },
      invoice: { companyId, status: { not: 'cancelled' }, currency: { not: 'EUR' } },
    },
    select: {
      id: true, amount: true, eurAmount: true, paymentDate: true, paymentMethod: true,
      invoice: { select: { id: true, invoiceNumber: true, customerId: true, currency: true, total: true, eurTotal: true, exchangeRate: true } },
    },
    orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
  })
  const rows: Kursdifferenz[] = []
  for (const p of payments) {
    const nominal = nominalEur(p.amount, p.invoice)
    const differenz = r2(Number(p.eurAmount) - nominal)
    if (differenz === 0) continue
    rows.push({
      paymentId: p.id,
      invoiceId: p.invoice.id,
      invoiceNumber: p.invoice.invoiceNumber,
      customerId: p.invoice.customerId,
      paymentDate: p.paymentDate,
      paymentMethod: p.paymentMethod,
      currency: p.invoice.currency,
      nominalEur: nominal,
      eurAmount: Number(p.eurAmount),
      differenz,
    })
  }
  return {
    gewinn: r2(rows.filter((r) => r.differenz > 0).reduce((s, r) => s + r.differenz, 0)),
    verlust: r2(rows.filter((r) => r.differenz < 0).reduce((s, r) => s - r.differenz, 0)),
    rows,
  }
}
