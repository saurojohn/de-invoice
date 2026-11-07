/**
 * Tier 815 — the KSt and GewSt prepayments of a year, as KSt 1, the GewSt
 * form and the Bilanz's tax provision count them.
 *
 * Measured in the year-end dry run (a GmbH, 2025, 4 × 100 € GewSt and 4 ×
 * 100 € KSt prepaid, the KSt ones booked from the bank as expenses
 * „Körperschaftsteuer", Tier 808): the provision was the year's taxes less
 * the GewSt amounts *entered* on the accounting page — the KSt paid was not
 * subtracted (provision 400 € too high), and an amount entered but never
 * paid would have been.
 *
 * What the year's tax is reduced by is what was paid for it: the
 * prepayments of the tax (prepaymentTaxOf — not a Nachzahlung, an
 * Erstattung, a Beratung) paid within the year's prepayment window, from
 * PREPAYMENT_EARLY_DAYS before the first quarter's due date to
 * PREPAYMENT_LATE_DAYS after the fourth's (the window the deadlines use,
 * Tier 806). A company that books no payment in the app keeps what it
 * entered (source 'entered'), as before.
 */
import { PrismaService } from '../../prisma/prisma.service'
import { businessDayIso } from '../../common/business-date'
import {
  addDaysIso,
  PREPAYMENT_EARLY_DAYS,
  PREPAYMENT_LATE_DAYS,
  prepaymentDeadline,
  prepaymentTaxOf,
  type PrepaymentTax,
} from '../reports/filing-deadlines'

export interface PrepaymentsOfTax {
  /** entered on the accounting page (settings.<tax>Vorauszahlungen[year]) */
  entered: number
  /** paid for the year (expenses of the tax, within its window) */
  paid: number
  /** what the year's tax is reduced by */
  used: number
  source: 'paid' | 'entered' | 'none'
}

const r2 = (n: number) => Math.round(n * 100) / 100
const sumQ = (v: any) => ['q1', 'q2', 'q3', 'q4'].reduce((s, q) => s + (Number(v?.[q]) || 0), 0)

/** The days a prepayment for the year can be paid on (pure). */
export function prepaymentWindow(tax: PrepaymentTax, year: number, land?: string | null): { from: string; to: string } {
  return {
    from: addDaysIso(prepaymentDeadline(tax, year, 1, land), -PREPAYMENT_EARLY_DAYS),
    to: addDaysIso(prepaymentDeadline(tax, year, 4, land), PREPAYMENT_LATE_DAYS),
  }
}

export async function prepaymentsOfYear(
  prisma: PrismaService,
  companyId: string,
  year: number,
  settings: Record<string, any>,
  land?: string | null,
): Promise<Record<PrepaymentTax, PrepaymentsOfTax>> {
  const windows = { kst: prepaymentWindow('kst', year, land), gewst: prepaymentWindow('gewst', year, land) }
  const from = windows.kst.from < windows.gewst.from ? windows.kst.from : windows.gewst.from
  const to = windows.kst.to > windows.gewst.to ? windows.kst.to : windows.gewst.to
  const expenses = await prisma.expense.findMany({
    where: {
      companyId,
      status: { in: ['booked', 'deductible'] },
      paidAt: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T23:59:59.999Z`) },
      category: { not: null },
    },
    select: { category: true, grossAmount: true, paidAt: true },
  })
  const paid: Record<PrepaymentTax, { sum: number; rows: number }> = { kst: { sum: 0, rows: 0 }, gewst: { sum: 0, rows: 0 } }
  for (const e of expenses) {
    const tax = prepaymentTaxOf(e.category)
    if (!tax || !e.paidAt) continue
    const day = businessDayIso(e.paidAt)
    if (day < windows[tax].from || day > windows[tax].to) continue
    paid[tax].sum += Number(e.grossAmount)
    paid[tax].rows++
  }
  const one = (tax: PrepaymentTax): PrepaymentsOfTax => {
    const entered = r2(sumQ(settings[tax === 'kst' ? 'kstVorauszahlungen' : 'gewstVorauszahlungen']?.[year]))
    const p = r2(paid[tax].sum)
    if (paid[tax].rows > 0) return { entered, paid: p, used: p, source: 'paid' }
    return { entered, paid: 0, used: entered, source: entered ? 'entered' : 'none' }
  }
  return { kst: one('kst'), gewst: one('gewst') }
}
