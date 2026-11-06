/**
 * Tier 812 — the journal against the reports (Abstimmung).
 *
 * The EÜR, the GuV, the BWA, the Bilanz and the UStVA read the documents —
 * invoices, payments, expenses, the cash book, the UStVA's payments, the
 * asset register — and not the journal. Every voucher the app writes for a
 * document has its document in a report; what has none is in the journal and
 * in the DATEV export only:
 *  - a manual voucher (the accounting page's „Neuer Beleg") and a correction
 *    (`/vouchers/:id/correct`), with a line on an expense, revenue or VAT
 *    account;
 *  - a debit booked „Als Aufwand" before Tier 809 — a voucher on an expense
 *    account and no expense (the bank page takes it into the expenses).
 * Measured (Tier 812): a manual voucher „Miete 1 000 € + Vorsteuer 190 € an
 * Bank" left all five reports as they were. This lists such vouchers of a
 * year with what they would add — the reports are not changed (whether
 * manual vouchers should count in them is the owner's decision, open).
 *
 * A voucher with a Storno, and the Storno itself, cancel out and are left out.
 */
import { PrismaService } from '../../prisma/prisma.service'
import { businessDayIso, dayEnd, dayStart } from '../../common/business-date'

export type ReconKind = 'aufwand' | 'ertrag' | 'steuer'
export type ReconOrigin = 'manual' | 'correction' | 'bank-expense'

/** The vouchers written by hand: the page's, the corrections, and those of the manual route before Tier 811 (no type). */
const HAND = new Set(['Manual', 'VoucherCorrection'])

export function originOf(referenceType: string | null): ReconOrigin | null {
  if (referenceType === null || referenceType === 'Manual') return 'manual'
  if (referenceType === 'VoucherCorrection') return 'correction'
  if (referenceType === 'BankTransaction') return 'bank-expense'
  return null
}

/** What a line on this account would be in a report; null: a balance-sheet account the reports do not miss. */
export function kindOf(account: { type: string; category: string | null } | null, origin: ReconOrigin): ReconKind | null {
  if (!account) return null
  if (account.type === 'expense') return 'aufwand'
  if (account.type === 'revenue') return 'ertrag'
  // a bank tax payment (Tier 808) is on 1780 and in the reports through its
  // return or UstPayment — only a voucher written by hand misses its VAT
  if (account.category === 'vat' && origin !== 'bank-expense') return 'steuer'
  return null
}

export interface ReconVoucher {
  id: string
  voucherNumber: string
  date: Date
  description: string | null
  referenceType: string | null
  lines: Array<{ debit: unknown; credit: unknown; account: { accountNumber: string; name: string; type: string; category: string | null } | null }>
}

export interface ReconEntry {
  id: string
  voucherNumber: string
  date: string
  description: string | null
  origin: ReconOrigin
  lines: Array<{ accountNumber: string; name: string; kind: ReconKind; debit: number; credit: number }>
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function reconcile(vouchers: ReconVoucher[]): { entries: ReconEntry[]; totals: Record<ReconKind, number> } {
  const entries: ReconEntry[] = []
  const totals: Record<ReconKind, number> = { aufwand: 0, ertrag: 0, steuer: 0 }
  for (const v of vouchers) {
    const origin = originOf(v.referenceType)
    if (!origin) continue
    const lines: ReconEntry['lines'] = []
    for (const l of v.lines) {
      const kind = kindOf(l.account, origin)
      if (!kind || !l.account) continue
      const debit = r2(Number(l.debit) || 0)
      const credit = r2(Number(l.credit) || 0)
      lines.push({ accountNumber: l.account.accountNumber, name: l.account.name, kind, debit, credit })
      // the effect a report would show: costs and VAT paid on the debit side, revenue on the credit side
      totals[kind] += kind === 'ertrag' ? credit - debit : debit - credit
    }
    if (lines.length) {
      entries.push({ id: v.id, voucherNumber: v.voucherNumber, date: businessDayIso(v.date), description: v.description, origin, lines })
    }
  }
  return { entries, totals: { aufwand: r2(totals.aufwand), ertrag: r2(totals.ertrag), steuer: r2(totals.steuer) } }
}

export async function journalReconciliation(prisma: PrismaService, companyId: string, year: number) {
  const vouchers = await prisma.voucher.findMany({
    where: {
      companyId,
      status: 'posted',
      date: { gte: dayStart(year, 0, 1), lte: dayEnd(year, 11, 31) },
      OR: [{ referenceType: null }, { referenceType: { in: [...HAND, 'BankTransaction'] } }],
      // reversed: the voucher and its Storno cancel out
      reversals: { none: {} },
    },
    select: {
      id: true, voucherNumber: true, date: true, description: true, referenceType: true,
      lines: {
        select: { debit: true, credit: true, account: { select: { accountNumber: true, name: true, type: true, category: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: [{ date: 'asc' }, { voucherNumber: 'asc' }],
    take: 2000,
  })
  return { year, ...reconcile(vouchers), truncated: vouchers.length === 2000 }
}
