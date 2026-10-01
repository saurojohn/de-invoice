import { ConflictException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'

/**
 * Tier 489 — a supplier invoice is entered once.
 *
 * The same supplier's invoice number twice is the same bill twice: its
 * input tax deducted twice, its cost counted twice. Measured: RE-4711 of
 * one supplier entered three times (via /ustva/expenses and /expenses) —
 * 201 each, UStVA Vorsteuer 57 instead of 19. Returns the bill already
 * entered, or null. A credit note of the supplier (negative amounts) is a
 * document of its own even under the same number.
 */
export async function findDuplicateExpense(
  prisma: PrismaService,
  companyId: string,
  supplierId: string | null | undefined,
  invoiceNumber: string | null | undefined,
  creditNote: boolean,
) {
  const number = (invoiceNumber || '').trim()
  if (!supplierId || !number) return null
  return prisma.expense.findFirst({
    where: {
      companyId,
      supplierId,
      invoiceNumber: { equals: number, mode: 'insensitive' },
      grossAmount: creditNote ? { lt: 0 } : { gte: 0 },
    },
    select: { id: true, invoiceNumber: true, invoiceDate: true, grossAmount: true },
  })
}

export function duplicateExpenseMessage(dup: { invoiceNumber: string | null; invoiceDate: Date; grossAmount: unknown }) {
  return (
    `Die Eingangsrechnung ${dup.invoiceNumber} dieses Lieferanten ist bereits erfasst ` +
    `(${new Date(dup.invoiceDate).toLocaleDateString('de-DE')}, ${Number(dup.grossAmount).toFixed(2).replace('.', ',')} €). ` +
    'Ist es wirklich eine zweite Rechnung, mit „confirmDuplicate“ bestätigen.'
  )
}

export async function assertNoDuplicateExpense(
  prisma: PrismaService,
  companyId: string,
  supplierId: string | null | undefined,
  invoiceNumber: string | null | undefined,
  creditNote: boolean,
  confirmed?: boolean,
) {
  if (confirmed) return
  const dup = await findDuplicateExpense(prisma, companyId, supplierId, invoiceNumber, creditNote)
  if (dup) throw new ConflictException(duplicateExpenseMessage(dup))
}
