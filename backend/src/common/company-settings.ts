/**
 * Tier 795 — Company.settings is one JSON column that holds many things: the
 * DATEV numbers, the Anlage flags, the Hebesatz, the KSt/GewSt prepayments,
 * the Anlage N/R/Kind/SO/AUS figures, the dunning stages, the exchange rates,
 * the time rounding, the invoice number start… Each writer read the column,
 * changed its key and wrote the whole column back. Two writers at once — the
 * feature flags and the DATEV settings saved from two tabs — and the later
 * one wrote back the column as it was before the other's change. Measured:
 * 15 of 15 such pairs lost one of the two.
 *
 * A writer now reads the column under a row lock on the company (FOR NO KEY
 * UPDATE, to the end of its transaction): the second writer waits, then reads
 * what the first wrote. NO KEY: the foreign-key checks of an invoice or an
 * expense being saved for the company (FOR KEY SHARE) do not wait for it.
 * The write stays a Prisma update, so it is audited as before (Company is an
 * audited model).
 */
import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

/** Lock the company's row to the end of the transaction `tx`. */
export async function lockCompanyRow(tx: Prisma.TransactionClient, companyId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS one FROM "Company" WHERE id = ${companyId} FOR NO KEY UPDATE`
}

export type CompanySettings = Record<string, any>

/**
 * Read the company's settings under the lock, let `change` alter them in
 * place (it may throw: nothing is written), write them back. Returns what
 * `change` returns.
 */
export async function updateCompanySettings<R>(
  prisma: { $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> },
  companyId: string,
  change: (settings: CompanySettings) => R | Promise<R>,
): Promise<R> {
  return prisma.$transaction(async (tx) => {
    await lockCompanyRow(tx, companyId)
    const company = await tx.company.findUnique({ where: { id: companyId }, select: { settings: true } })
    if (!company) throw new BadRequestException('Firma nicht gefunden')
    const stored = company.settings
    const settings: CompanySettings =
      stored && typeof stored === 'object' && !Array.isArray(stored) ? structuredClone(stored as CompanySettings) : {}
    const result = await change(settings)
    await tx.company.update({ where: { id: companyId }, data: { settings: settings as Prisma.InputJsonValue } })
    return result
  })
}
