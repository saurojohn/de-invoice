/**
 * Tier 443 — correcting an expense (Eingangsrechnung).
 *
 * There was no way to: no PUT on /expenses or /ustva/expenses, so a typo in
 * an amount meant deleting the expense and entering it again. Shared by both
 * routes, like the credit-note rule (credit-note.ts).
 *
 * Amounts are entered positive as on create. When the net or the rate
 * changes and no VAT is given, the VAT is rate × net (to cents); when any of
 * them changes and no gross is given, gross = net + VAT. A credit note stays
 * one unless `creditNote: false` is sent.
 *
 * A paid or otherwise booked expense (expense-lock.ts) keeps everything but
 * its notes; the request is refused with the reason, which names the way out.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { signedExpenseAmounts } from './credit-note'
import { expenseLockReason } from './expense-lock'
import type { UpdateExpenseDto } from './dto/expense.dto'

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places
const sameDecimal = (a: unknown, b: number) => round(Number(a), 4) === round(b, 4)
const orNull = (s?: string | null) => (typeof s === 'string' && s.trim() ? s.trim() : null)

export async function updateExpense(
  prisma: PrismaService,
  companyId: string,
  id: string,
  data: UpdateExpenseDto,
) {
  const exp = await prisma.expense.findFirst({ where: { id, companyId } })
  if (!exp) throw new NotFoundException('Eingangsrechnung nicht gefunden')

  const changes: Record<string, unknown> = {}
  const set = (key: string, next: unknown, differs: boolean) => {
    if (differs) changes[key] = next
  }

  if (data.description !== undefined) set('description', data.description.trim(), data.description.trim() !== exp.description)
  if (data.invoiceDate !== undefined) {
    const d = new Date(data.invoiceDate)
    set('invoiceDate', d, d.getTime() !== exp.invoiceDate.getTime())
  }
  if (data.invoiceNumber !== undefined) set('invoiceNumber', orNull(data.invoiceNumber), orNull(data.invoiceNumber) !== exp.invoiceNumber)
  if (data.supplierId !== undefined) {
    const supplierId = orNull(data.supplierId)
    if (supplierId && supplierId !== exp.supplierId) {
      const sup = await prisma.supplier.findFirst({ where: { id: supplierId, companyId } })
      if (!sup) throw new BadRequestException('Lieferant nicht gefunden')
    }
    set('supplierId', supplierId, supplierId !== exp.supplierId)
  }
  if (data.category !== undefined) set('category', orNull(data.category), orNull(data.category) !== exp.category)
  if (data.accountNumber !== undefined) {
    const acc = orNull(data.accountNumber)?.slice(0, 20) ?? null
    set('accountNumber', acc, acc !== exp.accountNumber)
  }
  if (data.isIntraEU !== undefined) set('isIntraEU', data.isIntraEU, data.isIntraEU !== exp.isIntraEU)
  if (data.isReverseCharge !== undefined) set('isReverseCharge', data.isReverseCharge, data.isReverseCharge !== exp.isReverseCharge)

  // Amounts: work with magnitudes, then apply the sign.
  const creditNote = data.creditNote ?? Number(exp.grossAmount) < 0
  const rate = data.vatRate ?? Number(exp.vatRate)
  const net = data.netAmount ?? Math.abs(Number(exp.netAmount))
  const baseChanged = data.netAmount !== undefined || data.vatRate !== undefined
  const vat = data.vatAmount ?? (baseChanged ? round(net * rate, 2) : Math.abs(Number(exp.vatAmount)))
  const gross = data.grossAmount ??
    (baseChanged || data.vatAmount !== undefined ? round(net + vat, 4) : Math.abs(Number(exp.grossAmount)))
  const signed = signedExpenseAmounts(creditNote, { net, vat, gross })
  set('vatRate', rate, !sameDecimal(exp.vatRate, rate))
  set('netAmount', signed.net.toFixed(4), !sameDecimal(exp.netAmount, signed.net))
  set('vatAmount', signed.vat.toFixed(4), !sameDecimal(exp.vatAmount, signed.vat))
  set('grossAmount', signed.gross.toFixed(4), !sameDecimal(exp.grossAmount, signed.gross))

  if (Object.keys(changes).length > 0) {
    const reason = await expenseLockReason(prisma, companyId, exp)
    if (reason) throw new BadRequestException(reason)
  }
  if (data.notes !== undefined) set('notes', orNull(data.notes), orNull(data.notes) !== exp.notes)

  if (Object.keys(changes).length === 0) {
    return prisma.expense.findFirst({ where: { id, companyId }, include: { supplier: true } })
  }
  return prisma.expense.update({
    where: { id },
    data: changes,
    include: { supplier: true },
  })
}
