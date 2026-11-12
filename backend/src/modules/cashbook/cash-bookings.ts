/**
 * Tier 425 — cash-book entries that are business income or expenses of
 * their own.
 *
 * A Kassenbuch entry reaches the books in one of three ways:
 *   - linked to an invoice (Barzahlung at the counter): it records a Payment;
 *     the invoice is what the reports count
 *   - linked to an expense: it dates the expense's payment; the expense is
 *     what the reports count
 *   - on its own with a VAT rate (0 included): a cash sale or a cash
 *     purchase — counted here, in the UStVA, EÜR, GuV, BWA and DATEV
 * An entry without a VAT rate is money moving without being income or
 * expense (Privateinlage / -entnahme, Geldtransit) and is not counted —
 * except the counted difference a Tagesabschluss booked (Tier 838,
 * `kassendifferenz`): a Fehlbetrag is a sonstiger betrieblicher Aufwand, an
 * Überschuss a sonstiger Ertrag, both without Umsatzsteuer (no supply behind
 * them that the app knows of — whether an Überschuss was an unrecorded sale is
 * the Berater's call). Every report books it so; the UStVA leaves it out.
 *
 * Measured before: a 119 € cash sale at 19 % and a 59,50 € cash purchase
 * appeared in no report — 19 € output tax undeclared, 9,50 € input tax not
 * claimed.
 *
 * Amounts are gross (as entered); a Storno is negative and nets out.
 */
import { PrismaService } from '../../prisma/prisma.service'

export interface CashBooking {
  id: string
  date: Date
  /** 'in' = einnahme, 'out' = ausgabe */
  direction: 'in' | 'out'
  rate: number
  gross: number
  net: number
  vat: number
  description: string
  belegNumber: string | null
  /** Tier 838: a counted difference of a Tagesabschluss, not a sale or purchase */
  kassendifferenz: boolean
}

const r2 = (n: number) => Math.round(n * 100) / 100

export async function cashBookings(
  prisma: PrismaService,
  companyId: string,
  start: Date,
  end: Date,
): Promise<CashBooking[]> {
  const rows = await prisma.cashBookEntry.findMany({
    where: {
      companyId,
      businessDate: { gte: start, lte: end },
      type: { in: ['einnahme', 'ausgabe'] },
      OR: [{ vatRate: { not: null } }, { kind: 'kassendifferenz' }],
      invoiceId: null,
      expenseId: null,
    },
    orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map((e) => {
    const gross = Number(e.amount)
    const rate = Number(e.vatRate ?? 0)
    const net = r2(gross / (1 + rate))
    return {
      id: e.id,
      date: e.businessDate,
      direction: e.type === 'einnahme' ? 'in' : 'out',
      rate,
      gross: r2(gross),
      net,
      vat: r2(gross - net),
      description: e.description,
      belegNumber: e.belegNumber,
      kassendifferenz: e.kind === 'kassendifferenz',
    }
  })
}
