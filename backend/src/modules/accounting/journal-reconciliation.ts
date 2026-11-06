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
 *
 * A correction (`/correct`: Storno + „<number>-K<n>") of a document's voucher
 * — an invoice's, a bank match's, a bill's payment — changes the journal and
 * not the document (Tiers 444 / 446: on purpose, its accounts change): what
 * it adds is the correction less the document's voucher, by account; a
 * change of account alone adds nothing the reports miss and is not listed.
 * A correction of a manual voucher or of an old bank expense is listed whole.
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

/** The voucher a correction goes back to: „4711-K1-K2" → „4711". */
export function rootNumberOf(voucherNumber: string): string {
  let n = voucherNumber
  while (/-K\d+$/.test(n)) n = n.replace(/-K\d+$/, '')
  return n
}

export function reconcile(
  vouchers: ReconVoucher[],
  roots: Map<string, ReconVoucher> = new Map(),
): { entries: ReconEntry[]; totals: Record<ReconKind, number> } {
  const entries: ReconEntry[] = []
  const totals: Record<ReconKind, number> = { aufwand: 0, ertrag: 0, steuer: 0 }
  for (const v of vouchers) {
    let origin = originOf(v.referenceType)
    if (!origin) continue
    // a correction counts as what it corrects
    let against: ReconVoucher | null = null
    if (origin === 'correction') {
      const root = roots.get(rootNumberOf(v.voucherNumber))
      const rootOrigin = root ? originOf(root.referenceType) : 'manual'
      if (rootOrigin === null) against = root!
      else if (rootOrigin === 'bank-expense') origin = 'bank-expense'
    }
    // by account: the voucher's lines, less the document voucher's it corrects
    const byAccount = new Map<string, { accountNumber: string; name: string; kind: ReconKind; net: number }>()
    const add = (l: ReconVoucher['lines'][number], sign: number, o: ReconOrigin) => {
      const kind = kindOf(l.account, o)
      if (!kind || !l.account) return
      const cur = byAccount.get(l.account.accountNumber) ?? { accountNumber: l.account.accountNumber, name: l.account.name, kind, net: 0 }
      cur.net += sign * ((Number(l.debit) || 0) - (Number(l.credit) || 0))
      byAccount.set(l.account.accountNumber, cur)
    }
    for (const l of v.lines) add(l, 1, origin === 'correction' && against ? 'manual' : origin)
    if (against) for (const l of against.lines) add(l, -1, 'manual')
    const lines: ReconEntry['lines'] = []
    for (const a of byAccount.values()) {
      const net = r2(a.net)
      if (Math.abs(net) < 0.005) continue
      lines.push({ accountNumber: a.accountNumber, name: a.name, kind: a.kind, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 })
    }
    // a correction of a document that moves an amount between accounts of one kind adds nothing
    const effect: Record<ReconKind, number> = { aufwand: 0, ertrag: 0, steuer: 0 }
    for (const l of lines) effect[l.kind] += l.kind === 'ertrag' ? l.credit - l.debit : l.debit - l.credit
    if (against && Object.values(effect).every((x) => Math.abs(x) < 0.005)) continue
    // the effect a report would show: costs and VAT paid on the debit side, revenue on the credit side
    for (const k of Object.keys(effect) as ReconKind[]) totals[k] += effect[k]
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
  // what the corrections go back to
  const rootNumbers = [...new Set(vouchers.filter((v) => v.referenceType === 'VoucherCorrection').map((v) => rootNumberOf(v.voucherNumber)))]
  const rootRows = rootNumbers.length
    ? await prisma.voucher.findMany({
      where: { companyId, voucherNumber: { in: rootNumbers } },
      select: {
        id: true, voucherNumber: true, date: true, description: true, referenceType: true,
        lines: { select: { debit: true, credit: true, account: { select: { accountNumber: true, name: true, type: true, category: true } } } },
      },
    })
    : []
  const roots = new Map(rootRows.map((r) => [r.voucherNumber, r]))
  return { year, ...reconcile(vouchers, roots), truncated: vouchers.length === 2000 }
}
