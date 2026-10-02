import { isKapitalgesellschaft, resolveRechtsform } from '../company/rechtsform'

/**
 * Tier 504 — the home office of a sole trader / partner (since 2023):
 *
 *  - Tagespauschale (§ 4 Abs. 5 Nr. 6c EStG): 6 € for each day the work is
 *    done mainly at home, at most 210 days = 1 260 € a year;
 *  - Jahrespauschale (Nr. 6b): 1 260 € for a häusliches Arbeitszimmer that
 *    is the centre of the whole activity, a twelfth less for each full month
 *    without it.
 *
 * Neither could be claimed: no expense category or field marked it, so the
 * EÜR / Anlage S / G lacked it (the Berater added it by hand). The actual
 * costs of an Arbeitszimmer instead of the Jahrespauschale stay expenses.
 * A Kapitalgesellschaft has no Betriebsausgabe here (its managing director
 * claims it as Werbungskosten).
 */
export const HOME_OFFICE_METHODS = ['tagespauschale', 'jahrespauschale'] as const
export const TAGESPAUSCHALE = 6
export const MAX_TAGE = 210
export const JAHRESPAUSCHALE = 1260

export function homeOfficeAmount(row: { method: string; days?: number | null; months?: number | null }): number {
  if (row.method === 'jahrespauschale') {
    const months = Math.max(0, Math.min(12, row.months ?? 12))
    return Math.round((JAHRESPAUSCHALE * months) / 12 * 100) / 100
  }
  const days = Math.max(0, Math.min(MAX_TAGE, row.days ?? 0))
  return days * TAGESPAUSCHALE
}

/** The year's home-office deduction (0 without an entry or for a Kapitalgesellschaft). */
export async function homeOfficeDeduction(prisma: any, companyId: string, year: number): Promise<number> {
  const [row, company] = await Promise.all([
    prisma.homeOffice.findUnique({ where: { companyId_year: { companyId, year } } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, legalName: true, rechtsform: true, settings: true } }),
  ])
  if (!row || !company || isKapitalgesellschaft(resolveRechtsform(company).rechtsform)) return 0
  return homeOfficeAmount(row)
}
