/**
 * Tier 443 — when an expense can no longer be changed or deleted.
 *
 * An expense (Eingangsrechnung) is open until it is paid or belongs to another
 * booking. Then the books hold more than the expense row: a SEPA batch that
 * paid it, a cash-book Ausgabe, a bank voucher, the asset register's AfA run.
 * Deleting it — which DELETE /ustva/expenses/:id did unchecked — took the cost,
 * the input tax and the DATEV payment row out of the books while the money had
 * left; changing its amounts would do the same by halves.
 *
 * Each reason names the way out: a correction of a paid bill is a supplier
 * credit note (Tier 442), a payment is taken back where it was made (SEPA
 * storno, cash-book storno, voucher storno), AfA through the AfA storno.
 */
import { PrismaService } from '../../prisma/prisma.service'

type LockableExpense = {
  id: string
  paidAt: Date | null
  paidBySepaBatchId: string | null
  relatedAssetId: string | null
}

/** Reasons keyed by expense id; an expense without an entry is open. */
export async function expenseLockReasons(
  prisma: PrismaService,
  companyId: string,
  expenses: LockableExpense[],
): Promise<Map<string, string>> {
  const reasons = new Map<string, string>()
  if (expenses.length === 0) return reasons
  const ids = expenses.map((e) => e.id)

  // A cash-book Ausgabe that is not reversed pays the expense. A Storno pair
  // stays linked (Tier 425) but has taken the payment back.
  const cash = await prisma.cashBookEntry.findMany({
    where: { companyId, expenseId: { in: ids }, reversesId: null, reversedBy: null },
    select: { expenseId: true },
  })
  const paidInCash = new Set(cash.map((c) => c.expenseId))

  // The bank import's voucher carries "[expense:<id>]" (bank-import.service
  // bookExpense); a reversed one no longer books the payment.
  const vouchers = await prisma.voucher.findMany({
    where: {
      companyId,
      referenceType: 'Expense',
      reversals: { none: {} },
      OR: ids.map((id) => ({ description: { contains: `[expense:${id}]` } })),
    },
    select: { voucherNumber: true, description: true },
  })
  const bankVoucher = (id: string) =>
    vouchers.find((v) => (v.description || '').includes(`[expense:${id}]`))

  for (const e of expenses) {
    const voucher = bankVoucher(e.id)
    if (e.relatedAssetId) {
      reasons.set(e.id, 'Die Ausgabe ist eine AfA-Buchung des Anlagenverzeichnisses. Nehmen Sie sie dort mit „AfA stornieren“ zurück.')
    } else if (e.paidBySepaBatchId) {
      reasons.set(e.id, 'Die Eingangsrechnung ist per SEPA-Überweisung bezahlt. Stornieren Sie zuerst den SEPA-Batch, oder korrigieren Sie sie mit einer Gutschrift des Lieferanten.')
    } else if (paidInCash.has(e.id)) {
      reasons.set(e.id, 'Die Eingangsrechnung ist aus dem Kassenbuch bezahlt. Stornieren Sie zuerst die Kassenbuchung, oder korrigieren Sie sie mit einer Gutschrift des Lieferanten.')
    } else if (voucher) {
      reasons.set(e.id, `Die Eingangsrechnung ist über die Bank bezahlt (Beleg ${voucher.voucherNumber}). Stornieren Sie zuerst den Beleg, oder korrigieren Sie sie mit einer Gutschrift des Lieferanten.`)
    } else if (e.paidAt) {
      reasons.set(e.id, 'Die Eingangsrechnung ist bereits bezahlt. Korrigieren Sie sie mit einer Gutschrift des Lieferanten.')
    }
  }
  return reasons
}

export async function expenseLockReason(
  prisma: PrismaService,
  companyId: string,
  expense: LockableExpense,
): Promise<string | null> {
  return (await expenseLockReasons(prisma, companyId, [expense])).get(expense.id) ?? null
}
