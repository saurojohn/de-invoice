/**
 * Tier 816 — what the journal's own bookings add to the reports.
 *
 * The reports read the documents (invoices, expenses, payments, the cash
 * book, the asset register). A voucher written by hand has no document: a
 * manual voucher (the accounting page's „Neuer Beleg"), a correction
 * (`/correct`), a bank debit booked „Als Aufwand" before Tier 809. Measured
 * (Tier 812): „Miete 1 000 € + Vorsteuer an Bank" changed no report.
 *
 * Decided on 07.11.2026 — the owner left it to the accountant's judgement:
 *  - GuV, BWA, Anlage G of a balance-sheet company — and with them the
 *    E-Bilanz, KSt 1, the GewSt and the Bilanz's net income — count their
 *    lines on expense and revenue accounts, as the adviser's DATEV does:
 *    year-end and reclassification entries are booked this way;
 *  - the EÜR and its forms count a voucher's lines only when it moved money
 *    (a line on a cash or bank account; `cashOnly`) — § 4 Abs. 3 EStG knows
 *    no accrual entry;
 *  - the UStVA does not add their VAT: the input tax needs an invoice
 *    (§ 15 UStG) and a return its documents; a manual VAT line may repeat a
 *    bill entered. The UStVA lists them instead (journal-reconciliation.ts).
 *
 * Counted, each in its own period: manual vouchers (`Manual`, and no type —
 * the manual route before Tier 811), corrections (`VoucherCorrection`), old
 * bank expenses (`BankTransaction`, their expense and revenue lines), and the
 * Storno of any of these — and the Storno a correction writes of a
 * document's voucher, so that a correction of a document counts by what it
 * changes. A plain Storno of a document's voucher is not counted: the
 * document's own Storno handles it (Tiers 444, 809, 810).
 *
 * Income taxes booked by hand (KSt / Soli on 2200–2289, GewSt on 4320) are
 * kind 'steuer': the BWA shows them (bucket 5000), the GuV leaves them out
 * (it computes the year's taxes, position 14).
 */
import { PrismaService } from '../../prisma/prisma.service'
import { businessDayIso } from '../../common/business-date'

export type ManualKind = 'umsatz' | 'ertrag' | 'zinsertrag' | 'material' | 'personal' | 'raum' | 'afa' | 'zins' | 'steuer' | 'sonstige'

export interface ManualLine {
  date: string
  voucherNumber: string
  accountNumber: string
  kind: ManualKind
  /** what it adds: a cost or an income, positive; its Storno negative */
  amount: number
}

const HAND = ['Manual', 'VoucherCorrection', 'BankTransaction']

/** Where a line on this account goes (SKR03 ranges; any other chart: revenue / other costs). */
export function manualKindOf(account: { accountNumber: string; type: string; category: string | null }): ManualKind | null {
  const n = Number(account.accountNumber)
  if (account.type === 'revenue') {
    if (n >= 8000 && n <= 8999) return 'umsatz'
    if (n >= 2650 && n <= 2699) return 'zinsertrag'
    return 'ertrag'
  }
  if (account.type !== 'expense') return null
  if ((n >= 2200 && n <= 2289) || n === 4320) return 'steuer'
  if (n >= 3000 && n <= 3999) return 'material'
  if (n >= 4100 && n <= 4199) return 'personal'
  if (n >= 4200 && n <= 4299) return 'raum'
  if (n >= 4800 && n <= 4899) return 'afa'
  if (n >= 2100 && n <= 2199) return 'zins'
  return 'sonstige'
}

const INCOME: ManualKind[] = ['umsatz', 'ertrag', 'zinsertrag']

/** The vouchers of the period that count (see the header), with their lines. */
async function countedVouchers(prisma: PrismaService, companyId: string, start: Date, end: Date) {
  const vouchers = await prisma.voucher.findMany({
    where: {
      companyId,
      status: 'posted',
      date: { gte: start, lte: end },
      OR: [{ referenceType: null }, { referenceType: { in: [...HAND, 'VoucherReversal'] } }],
    },
    select: {
      voucherNumber: true,
      date: true,
      referenceType: true,
      reversedBy: { select: { voucherNumber: true, referenceType: true } },
      lines: { select: { debit: true, credit: true, account: { select: { accountNumber: true, name: true, type: true, category: true } } } },
    },
  })
  // a Storno of a document's voucher counts only when a correction wrote it
  const docStornoOf = vouchers
    .filter((v) => v.referenceType === 'VoucherReversal' && v.reversedBy && v.reversedBy.referenceType !== null && !HAND.includes(v.reversedBy.referenceType))
    .map((v) => v.reversedBy!.voucherNumber)
  const corrected = docStornoOf.length
    ? new Set((await prisma.voucher.findMany({
      where: { companyId, referenceType: 'VoucherCorrection', OR: docStornoOf.map((n) => ({ voucherNumber: { startsWith: `${n}-K` } })) },
      select: { voucherNumber: true },
    })).map((k) => k.voucherNumber.replace(/-K\d+$/, '')))
    : new Set<string>()

  return vouchers.filter((v) => {
    if (v.referenceType !== 'VoucherReversal') return true
    if (!v.reversedBy) return false
    const t = v.reversedBy.referenceType
    return t === null || HAND.includes(t) || corrected.has(v.reversedBy.voucherNumber)
  })
}

export async function manualJournalLines(
  prisma: PrismaService,
  companyId: string,
  start: Date,
  end: Date,
  opts: { cashOnly?: boolean } = {},
): Promise<ManualLine[]> {
  const out: ManualLine[] = []
  for (const v of await countedVouchers(prisma, companyId, start, end)) {
    if (opts.cashOnly && !v.lines.some((l) => l.account?.category === 'liquidity')) continue
    for (const l of v.lines) {
      if (!l.account) continue
      const kind = manualKindOf(l.account)
      if (!kind) continue
      const net = (Number(l.debit) || 0) - (Number(l.credit) || 0)
      const amount = Math.round((INCOME.includes(kind) ? -net : net) * 100) / 100
      if (Math.abs(amount) < 0.005) continue
      out.push({ date: businessDayIso(v.date), voucherNumber: v.voucherNumber, accountNumber: l.account.accountNumber, kind, amount })
    }
  }
  return out
}

/** The lines summed by kind. */
export function sumByKind(lines: ManualLine[]): Record<ManualKind, number> {
  const s: Record<ManualKind, number> = { umsatz: 0, ertrag: 0, zinsertrag: 0, material: 0, personal: 0, raum: 0, afa: 0, zins: 0, steuer: 0, sonstige: 0 }
  for (const l of lines) s[l.kind] = Math.round((s[l.kind] + l.amount) * 100) / 100
  return s
}

export interface ManualVat {
  /** Vorsteuer booked by hand (debit on an input-tax account), net of its Storno */
  vorsteuer: number
  /** Umsatzsteuer booked by hand (credit on an output-tax account) */
  umsatzsteuer: number
  vouchers: Array<{ voucherNumber: string; date: string; accountNumber: string; name: string; amount: number }>
}

/**
 * Tier 816 — the VAT lines of the period's manual vouchers (an input-tax
 * account is an asset, an output-tax account a liability, both category
 * 'vat'). The UStVA does not add them (see the header): it shows them, so
 * that nobody files a return believing they are in it. A bank voucher's line
 * on 1780 (a VAT payment, Tier 808) is no tax and not shown.
 */
export async function manualVat(prisma: PrismaService, companyId: string, start: Date, end: Date): Promise<ManualVat> {
  const out: ManualVat = { vorsteuer: 0, umsatzsteuer: 0, vouchers: [] }
  for (const v of await countedVouchers(prisma, companyId, start, end)) {
    if (v.referenceType === 'BankTransaction' || (v.referenceType === 'VoucherReversal' && v.reversedBy?.referenceType === 'BankTransaction')) continue
    for (const l of v.lines) {
      if (!l.account || l.account.category !== 'vat') continue
      const net = (Number(l.debit) || 0) - (Number(l.credit) || 0)
      if (Math.abs(net) < 0.005) continue
      const input = l.account.type === 'asset'
      const amount = Math.round((input ? net : -net) * 100) / 100
      if (input) out.vorsteuer = Math.round((out.vorsteuer + amount) * 100) / 100
      else out.umsatzsteuer = Math.round((out.umsatzsteuer + amount) * 100) / 100
      out.vouchers.push({ voucherNumber: v.voucherNumber, date: businessDayIso(v.date), accountNumber: l.account.accountNumber, name: l.account.name, amount })
    }
  }
  return out
}
