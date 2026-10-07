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
 *
 * Tier 454: `paidAt` — the payment date entered by hand (null takes it out).
 * Where the bank, SEPA or the cash book paid the expense, the lock refuses it
 * like any other change.
 */
import { assertPeriodOpen } from '../reports/filed-period';
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { signedExpenseAmounts } from './credit-note'
import { expenseLockReason } from './expense-lock'
import type { UpdateExpenseDto } from './dto/expense.dto'
import { assertNotFuture } from '../../common/business-date'
import { assertExpenseAmounts } from './amounts'
import { checkTaxLines } from './tax-lines'

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places
const sameDecimal = (a: unknown, b: number) => round(Number(a), 4) === round(b, 4)
const orNull = (s?: string | null) => (typeof s === 'string' && s.trim() ? s.trim() : null)

export async function updateExpense(
  prisma: PrismaService,
  companyId: string,
  id: string,
  data: UpdateExpenseDto,
) {
  const exp = await prisma.expense.findFirst({ where: { id, companyId }, include: { taxLines: { orderBy: { position: 'asc' } } } })
  if (!exp) throw new NotFoundException('Eingangsrechnung nicht gefunden')
  const withLines = { supplier: true, taxLines: { select: { vatRate: true, netAmount: true, vatAmount: true, position: true }, orderBy: { position: 'asc' as const } } }

  const changes: Record<string, unknown> = {}
  const set = (key: string, next: unknown, differs: boolean) => {
    if (differs) changes[key] = next
  }

  if (data.description !== undefined) set('description', data.description.trim(), data.description.trim() !== exp.description)
  if (data.invoiceDate !== undefined) {
    assertNotFuture(data.invoiceDate, 'Das Rechnungsdatum') // Tier 515
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
  // Tier 503
  if (data.giftRecipient !== undefined) set('giftRecipient', orNull(data.giftRecipient), orNull(data.giftRecipient) !== exp.giftRecipient)
  // Tier 539
  if (data.bewirtungAnlass !== undefined) set('bewirtungAnlass', orNull(data.bewirtungAnlass), orNull(data.bewirtungAnlass) !== exp.bewirtungAnlass)
  if (data.bewirtungTeilnehmer !== undefined) set('bewirtungTeilnehmer', orNull(data.bewirtungTeilnehmer), orNull(data.bewirtungTeilnehmer) !== exp.bewirtungTeilnehmer)
  if (data.accountNumber !== undefined) {
    const acc = orNull(data.accountNumber)?.slice(0, 20) ?? null
    set('accountNumber', acc, acc !== exp.accountNumber)
  }
  if (data.isIntraEU !== undefined) set('isIntraEU', data.isIntraEU, data.isIntraEU !== exp.isIntraEU)
  if (data.paidAt !== undefined) {
    assertNotFuture(data.paidAt, 'Das Zahldatum') // Tier 515
    const d = data.paidAt ? new Date(data.paidAt) : null
    set('paidAt', d, (d?.getTime() ?? null) !== (exp.paidAt?.getTime() ?? null))
  }
  if (data.isReverseCharge !== undefined) set('isReverseCharge', data.isReverseCharge, data.isReverseCharge !== exp.isReverseCharge)

  // Amounts: work with magnitudes, then apply the sign.
  const creditNote = data.creditNote ?? Number(exp.grossAmount) < 0
  // Tier 581: the VAT lines of an expense with several rates. `taxLines`
  // replaces them (one line, or [], makes it a one-rate expense again); left
  // out (or null) the rows stay.
  let newRows: { position: number; vatRate: number; netAmount: string; vatAmount: string }[] | null = null
  const scalarAmounts = data.netAmount !== undefined || data.vatAmount !== undefined || data.grossAmount !== undefined || data.vatRate !== undefined
  if (data.taxLines !== undefined && data.taxLines !== null && data.taxLines.length > 0) {
    if ((data.isIntraEU ?? exp.isIntraEU) || (data.isReverseCharge ?? exp.isReverseCharge)) {
      throw new BadRequestException('Steuerzeilen gibt es nicht bei § 13b / innergemeinschaftlichem Erwerb — dort weist die Rechnung keine Steuer aus.')
    }
    const checked = checkTaxLines(data.taxLines, creditNote, { net: data.netAmount, vat: data.vatAmount, gross: data.grossAmount })
    newRows = checked.rows
    set('vatRate', checked.rate, !sameDecimal(exp.vatRate, checked.rate))
    set('netAmount', checked.net.toFixed(4), !sameDecimal(exp.netAmount, checked.net))
    set('vatAmount', checked.vat.toFixed(4), !sameDecimal(exp.vatAmount, checked.vat))
    set('grossAmount', checked.gross.toFixed(4), !sameDecimal(exp.grossAmount, checked.gross))
  } else if (exp.taxLines.length > 0 && data.taxLines == null && scalarAmounts) {
    throw new BadRequestException(
      'Diese Ausgabe hat mehrere Steuersätze. Bitte die Steuerzeilen (taxLines) ändern — oder mit einer leeren Liste zu einem einzigen Steuersatz machen.',
    )
  } else if (exp.taxLines.length > 0 && data.taxLines == null) {
    // nothing about the amounts — but a credit note turned into an invoice (or back) turns every line
    if (creditNote !== Number(exp.grossAmount) < 0) {
      const sign = creditNote ? -1 : 1
      newRows = exp.taxLines.map((l, position) => ({
        position,
        vatRate: Number(l.vatRate),
        netAmount: (sign * Math.abs(Number(l.netAmount))).toFixed(4),
        vatAmount: (sign * Math.abs(Number(l.vatAmount))).toFixed(4),
      }))
      for (const k of ['netAmount', 'vatAmount', 'grossAmount'] as const) {
        const next = sign * Math.abs(Number(exp[k]))
        set(k, next.toFixed(4), !sameDecimal(exp[k], next))
      }
    }
  } else {
    if (exp.taxLines.length > 0) newRows = [] // taxLines: [] — back to one rate, from the amounts given
    const rate = data.vatRate ?? Number(exp.vatRate)
    const net = data.netAmount ?? Math.abs(Number(exp.netAmount))
    const baseChanged = data.netAmount !== undefined || data.vatRate !== undefined
    const vat = data.vatAmount ?? (baseChanged ? round(net * rate, 2) : Math.abs(Number(exp.vatAmount)))
    const gross = data.grossAmount ??
      (baseChanged || data.vatAmount !== undefined ? round(net + vat, 4) : Math.abs(Number(exp.grossAmount)))
    const signed = signedExpenseAmounts(creditNote, { net, vat, gross })
    // Tier 523 — only when an amount is being changed (a row from before stays editable otherwise).
    if (baseChanged || data.vatAmount !== undefined || data.grossAmount !== undefined || newRows) {
      assertExpenseAmounts({ ...signed, rate })
    }
    set('vatRate', rate, !sameDecimal(exp.vatRate, rate))
    set('netAmount', signed.net.toFixed(4), !sameDecimal(exp.netAmount, signed.net))
    set('vatAmount', signed.vat.toFixed(4), !sameDecimal(exp.vatAmount, signed.vat))
    set('grossAmount', signed.gross.toFixed(4), !sameDecimal(exp.grossAmount, signed.gross))
  }
  // are the rows really different from what is stored?
  if (newRows) {
    const same =
      newRows.length === exp.taxLines.length &&
      newRows.every((r, i) =>
        sameDecimal(exp.taxLines[i].vatRate, r.vatRate) &&
        sameDecimal(exp.taxLines[i].netAmount, Number(r.netAmount)) &&
        sameDecimal(exp.taxLines[i].vatAmount, Number(r.vatAmount)))
    if (same) newRows = null
  }
  const linesChanged = newRows !== null

  if (Object.keys(changes).length > 0 || linesChanged) {
    // Tier 537: out of, or into, a submitted UStVA period
    await assertPeriodOpen(prisma, companyId, [exp.invoiceDate, changes.invoiceDate as Date | undefined], 'das Ändern einer Eingangsrechnung')
    const reason = await expenseLockReason(prisma, companyId, exp)
    if (reason) throw new BadRequestException(reason)
  }
  if (data.notes !== undefined) set('notes', orNull(data.notes), orNull(data.notes) !== exp.notes)

  if (Object.keys(changes).length === 0 && !linesChanged) {
    return prisma.expense.findFirst({ where: { id, companyId }, include: withLines })
  }
  return prisma.expense.update({
    where: { id },
    data: {
      ...changes,
      // one statement: the old rows go and the new ones come with the totals
      ...(newRows ? { taxLines: { deleteMany: {}, create: newRows.map((l) => ({ ...l, companyId })) } } : {}),
    },
    include: withLines,
  })
}
