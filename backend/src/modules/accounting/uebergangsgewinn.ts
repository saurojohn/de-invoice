/**
 * Tier 915 — the Übergangsgewinn of a change of the Gewinnermittlung
 * (R 4.6 EStR with its Anlage, H 4.6 EStH).
 *
 * The EÜR counts an invoice when it is paid, the Bilanz when it is issued. An
 * invoice issued in the last EÜR year and paid in the first Bilanz year was in
 * neither (measured: 1 000 € that no Anlage G counted); the other way round, a
 * receivable of the last Bilanz year would count again when paid under the
 * EÜR. The change itself settles it, in the first year of the new method:
 *
 *   + the receivables open at its start (gross — the EÜR counts the VAT
 *     received as income)
 *   − the expenses unpaid at its start (gross)
 *   − the Umsatzsteuer still owed to the Finanzamt then (the year's UStVA less
 *     the payments recorded by 31.12., as the Bilanz has it — Tier 506); a
 *     refund due adds
 *   − Tier 919: what was received before it for a supply after it (net — an
 *     erhaltene Anzahlung; the EÜR counted it when received, the Bilanz counts
 *     it with the supply)
 *
 * added on the way to the Bilanz, taken off on the way to the EÜR. An
 * application to spread a gain over three years (R 4.6 Abs. 1 Satz 4 EStR) is
 * the Berater's, as the hint says.
 */
import { Prisma } from '@prisma/client'
import { CLAIM_TYPES, NON_CASH_PAYMENT_METHODS } from '../invoice/document-scope'
import { gewinnermittlungWechselIn, type GewinnWechsel } from '../company/gewinnermittlung'

type Db = { $queryRaw: <T>(q: TemplateStringsArray | Prisma.Sql, ...v: unknown[]) => Promise<T> }

export interface Uebergang {
  ab: number
  von: 'euer' | 'bilanz'
  nach: 'euer' | 'bilanz'
  /** the receivables open at the start of the year `ab` (gross) */
  forderungen: number
  /** the expenses unpaid at the start of the year `ab` (gross) */
  verbindlichkeiten: number
  /** the Umsatzsteuer owed to the Finanzamt at the start of the year `ab` (negative: a refund due) */
  umsatzsteuer: number
  /** Tier 919: received before the start of the year `ab` for a supply after it (net — its VAT is in `umsatzsteuer`) */
  anzahlungen: number
  /** added to the profit of the year `ab` (negative: a loss) */
  betrag: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

export async function uebergangsgewinn(db: Db, companyId: string, w: GewinnWechsel, umsatzsteuer: number): Promise<Uebergang> {
  // the first day of the year `ab`, as the reports' periods start (Europe/Berlin)
  const start = new Date(w.ab, 0, 1)
  const [recv] = await db.$queryRaw<{ open: unknown }[]>(Prisma.sql`
    SELECT COALESCE(SUM(
      GREATEST(i.total - COALESCE(p.paid, 0), 0) / i.total * COALESCE(i."eurTotal", i.total)
    ), 0) AS open
    FROM "Invoice" i
    LEFT JOIN (
      SELECT y."invoiceId", SUM(y.amount) FILTER (WHERE y."paymentDate" < ${start}) AS paid
      FROM "Payment" y JOIN "Invoice" o ON o.id = y."invoiceId"
      WHERE o."companyId" = ${companyId}
      GROUP BY 1
    ) p ON p."invoiceId" = i.id
    WHERE i."companyId" = ${companyId}
      AND i.status NOT IN ('draft', 'cancelled')
      AND i.type IN (${Prisma.join(CLAIM_TYPES)})
      AND i.total > 0
      -- Tier 916 / 919: supplied before (as the Bilanz has its receivables)
      AND COALESCE(i."servicePeriodEnd", i."deliveryDate", i."issueDate") < ${start}
      -- set to paid by hand, without a payment: settled, we know no date
      AND NOT (i.status = 'paid' AND p."invoiceId" IS NULL)`)
  const [pay] = await db.$queryRaw<{ open: unknown }[]>(Prisma.sql`
    SELECT COALESCE(SUM(e."grossAmount"), 0) AS open
    FROM "Expense" e
    WHERE e."companyId" = ${companyId}
      AND e.status IN ('booked', 'deductible')
      AND (e.category IS NULL OR e.category <> 'AfA')
      AND e."relatedAssetId" IS NULL
      AND e."invoiceDate" < ${start}
      AND (e."paidAt" IS NULL OR e."paidAt" >= ${start})`)
  // Tier 919: paid in advance for a supply of the new year — counted as
  // income by the EÜR when received, by the Bilanz again with the supply
  // (Tier 924: less what a credit note took back before the change — owed back, no Anzahlung)
  const [adv] = await db.$queryRaw<{ net: unknown }[]>(Prisma.sql`
    SELECT COALESCE(SUM(
      GREATEST(p.paid - COALESCE(c.credited, 0), 0) / i.total * (COALESCE(i."eurTotal", i.total) - COALESCE(i."eurTotalVat", i."totalVat"))
    ), 0) AS net
    FROM "Invoice" i
    JOIN (
      SELECT y."invoiceId", SUM(y.amount) AS paid
      FROM "Payment" y JOIN "Invoice" o ON o.id = y."invoiceId"
      WHERE o."companyId" = ${companyId}
        AND y."paymentDate" < ${start}
        AND y."paymentMethod" NOT IN (${Prisma.join(NON_CASH_PAYMENT_METHODS)})
      GROUP BY 1
    ) p ON p."invoiceId" = i.id
    LEFT JOIN (
      SELECT n."referenceInvoiceId" AS rid, SUM(-n.total) AS credited
      FROM "Invoice" n
      WHERE n."companyId" = ${companyId} AND n.type = 'CN' AND n.status NOT IN ('draft', 'cancelled') AND n."issueDate" < ${start}
      GROUP BY 1
    ) c ON c.rid = i.id
    WHERE i."companyId" = ${companyId}
      AND i.status NOT IN ('draft', 'cancelled')
      AND i.type IN (${Prisma.join(CLAIM_TYPES)})
      AND i.total > 0
      AND COALESCE(i."servicePeriodEnd", i."deliveryDate", i."issueDate") >= ${start}`)
  const forderungen = r2(Number(recv.open))
  const verbindlichkeiten = r2(Number(pay.open))
  const sign = w.art === 'bilanz' ? 1 : -1
  const ust = r2(umsatzsteuer)
  const anzahlungen = r2(Number(adv.net))
  return {
    ab: w.ab, von: w.vorher, nach: w.art, forderungen, verbindlichkeiten, umsatzsteuer: ust, anzahlungen,
    betrag: r2(sign * (forderungen - verbindlichkeiten - ust - anzahlungen)),
  }
}

type UstvaLike = { computeMonths: (companyId: string, year: number) => Promise<Array<{ differenzbetrag: number }>> }
type FilingDb = Db & { uStvaFiling: { aggregate: (a: any) => Promise<any> } }

/** the Umsatzsteuer owed to the Finanzamt on 31.12. of a year — its UStVA less the payments recorded by then (as BilanzService.taxBalances) */
export async function ustOwedAtEndOf(db: FilingDb, ustva: UstvaLike, companyId: string, year: number): Promise<number> {
  let owed = 0
  for (const m of await ustva.computeMonths(companyId, year)) owed += m.differenzbetrag
  const paid = await db.uStvaFiling.aggregate({
    where: { companyId, year, paidAt: { lte: new Date(year, 11, 31, 23, 59, 59, 999) } },
    _sum: { paidAmount: true },
  })
  return owed - Number(paid._sum.paidAmount ?? 0)
}

/** the Übergangsgewinn of `year`, when a change of the Gewinnermittlung takes effect in it */
export async function uebergangOfYear(
  db: FilingDb,
  ustva: UstvaLike,
  company: Parameters<typeof gewinnermittlungWechselIn>[0] | null,
  companyId: string,
  year: number,
): Promise<Uebergang | null> {
  const w = company ? gewinnermittlungWechselIn(company, year) : null
  if (!w) return null
  return uebergangsgewinn(db, companyId, w, await ustOwedAtEndOf(db, ustva, companyId, w.ab - 1))
}
