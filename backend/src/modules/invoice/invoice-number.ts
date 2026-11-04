/**
 * Tier 404 — invoice numbering, once, per company.
 *
 * Two things were wrong with how this worked.
 *
 * **1. The sequence was shared by every tenant.** Tier 174 made numbering
 * atomic with a Postgres SEQUENCE per (type, year) — correct about the race it
 * set out to fix, but the sequence was global, and the per-company uniqueness
 * constraint hid the consequence. Measured on a throwaway stack with two fresh
 * companies:
 *
 *     A: INV-2026-000001
 *     B: INV-2026-000002
 *     B: INV-2026-000003
 *     B: INV-2026-000004
 *     A: INV-2026-000005
 *
 * Company A's books jump from 1 to 5. Every gap is another tenant's invoice, so
 * A can read off how much business B did between its own two invoices, and in a
 * Betriebsprüfung the operator has to explain missing numbers in a
 * *fortlaufende* Nummer (§ 14 Abs. 4 Nr. 4 UStG) with data they cannot show.
 * The sequence is now per (company, type, year).
 *
 * **2. There were two copies of this code.** `invoice.service.ts` and
 * `recurring.service.ts` each had their own, with a comment in the second
 * saying "the two implementations must stay in sync" — and they already
 * differed (the recurring one hardcoded `INV` and skipped the type guard).
 * Both now call this.
 *
 * Existing numbers are never touched: a company's sequence is created starting
 * *above* the highest number that company already used for that type and year,
 * so no issued invoice changes and no number is reused. GoBD § 146 forbids
 * altering a booked document; renumbering would be exactly that.
 */
import { BadRequestException } from '@nestjs/common'
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { lockCompanyRow } from '../../common/company-settings'

export type InvoiceNumberType = 'INV' | 'PI' | 'CN' | 'RCV' | 'QU' | 'DN' | 'OC'

export interface InvoiceNumber {
  invoiceNumber: string
  sequencePrefix: string
  sequenceYear: number
  sequenceNumber: number
}

/** The prefixes of the other documents — an invoice prefix cannot be one of them. */
export const RESERVED_NUMBER_PREFIXES = ['AN', 'LS', 'AB', 'CN', 'PI', 'RCV']

/**
 * Tier 692 — the invoice prefix of the settings page ("Rechnungsnummer-
 * Präfix", Company.invoicePrefix). It was stored and never read: a company
 * that set "RE" still numbered INV-2026-000001. Letters only (the numbers are
 * parsed as LETTERS-YEAR-NUMBER), not another document's prefix; anything else
 * is INV.
 */
export function ownInvoicePrefix(stored: string | null | undefined): string {
  const p = String(stored ?? '').trim().replace(/-$/, '').toUpperCase()
  return /^[A-Z]{1,10}$/.test(p) && !RESERVED_NUMBER_PREFIXES.includes(p) ? `${p}-` : 'INV-'
}

export function invoiceNumberPrefix(type: string, ownPrefix?: string | null): string {
  // Tier 610: a quote is numbered AN-… (Angebot), a delivery note LS-… (Lieferschein)
  if (type === 'QU') return 'AN-'
  if (type === 'DN') return 'LS-'
  if (type === 'OC') return 'AB-' // Tier 614: Auftragsbestätigung
  return type === 'CN' ? 'CN-' : type === 'PI' ? 'PI-' : type === 'RCV' ? 'RCV-' : ownInvoicePrefix(ownPrefix)
}

/**
 * The highest number this company has used with this prefix and year — on an
 * invoice, or (Tier 733) on an issued one that is gone: deleted on its issue
 * day, or left by a restore only as its kept copy (RetiredInvoiceNumber).
 * Tier 793: `year` null — of every year (a range that continues).
 */
async function usedMax(tx: Prisma.TransactionClient, companyId: string, prefix: string, year: number | null): Promise<number> {
  const like = year === null ? `${prefix}%` : `${prefix}${year}-%`
  const rows = await tx.$queryRaw<Array<{ max: bigint | null }>>`
    SELECT MAX(CAST(SUBSTRING(n FROM '([0-9]+)$') AS BIGINT)) AS max FROM (
      SELECT "invoiceNumber" AS n FROM "Invoice" WHERE "companyId" = ${companyId} AND "invoiceNumber" LIKE ${like}
      UNION ALL
      SELECT "invoiceNumber" AS n FROM "RetiredInvoiceNumber" WHERE "companyId" = ${companyId} AND "invoiceNumber" LIKE ${like}
    ) used
    WHERE n ~ ('^' || ${prefix} || '[0-9]{4}-[0-9]+$')
  `
  return Number(rows[0]?.max ?? 0)
}

/**
 * Tier 793 — the sequence of a company's range: one per document type that
 * continues over the years, or (`invoiceNumberContinuous` false) one per type
 * and year. Lowercase and unquoted on purpose (Tier 174).
 */
function sequenceName(type: string, year: number | null, companyId: string): string {
  return `invoice_seq_${type.toLowerCase()}_${year === null ? 'all' : year}_${companyToken(companyId)}`
}

/**
 * Postgres identifiers are limited to 63 bytes and may not contain hyphens
 * unquoted, so the company id becomes 32 hex characters. A uuid is used
 * directly; anything else (older seeds use readable ids) is hashed, which keeps
 * the name both valid and stable.
 */
function companyToken(companyId: string): string {
  const bare = (companyId || '').replace(/-/g, '').toLowerCase()
  if (/^[0-9a-f]{32}$/.test(bare)) return bare
  return createHash('sha1').update(companyId || '').digest('hex').slice(0, 32)
}

/**
 * Reserve the next number for this company. Must run inside a transaction so
 * the CREATE and the nextval share one connection — see the Tier 174 note in
 * git history about Prisma 5.22's identifier cache turning a mixed-case
 * sequence name into a permanent 42P01.
 */
export async function nextInvoiceNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
  type: InvoiceNumberType | string,
  year: number,
): Promise<InvoiceNumber> {
  // Tier 318's guards, kept: both values are interpolated into raw SQL.
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new BadRequestException(`Invalid year for invoice number: ${year}`)
  }
  if (!/^[A-Z]{2,5}$/.test(type)) {
    throw new BadRequestException(`Invalid invoice type: ${type}`)
  }
  if (!companyId) {
    throw new BadRequestException('companyId is required to number an invoice')
  }

  // Tier 692: an invoice takes the company's own prefix; the sequence stays
  // the type's, so a changed prefix continues the count
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { invoicePrefix: true, invoiceNumberContinuous: true, settings: true } })
  const prefix = invoiceNumberPrefix(type, type === 'INV' ? company?.invoicePrefix : null)
  // Tier 793: the count continues over the years unless the company starts
  // each year anew; the year stays in the number either way. The first number
  // of a continuing range comes after the highest of every year (usedMax), and
  // a taken one is skipped (below) — switching either way reuses nothing.
  const scope = company?.invoiceNumberContinuous === false ? year : null
  const seqName = sequenceName(type, scope, companyId)

  // Tier 775: looked up every time. A set of the sequences this process had
  // created remembered one whose CREATE was in a transaction that then rolled
  // back: DDL rolls back in PostgreSQL, the set did not, and every later number
  // of that company and year was a 500 (`relation … does not exist`) until a
  // restart. A run refused after it took its number did that with the first
  // invoice of a new year.
  let existing = await tx.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one FROM pg_class WHERE relkind = 'S' AND relname = ${seqName}
  `
  if (existing.length === 0) {
    // Tier 783: one creator per sequence. Two documents of a new year (or of a
    // new company) at once both found no sequence, and CREATE SEQUENCE IF NOT
    // EXISTS does not wait for the other transaction's CREATE: it fails on the
    // catalog's unique index (23505). Measured: six invoices of a new company
    // at once, five answered 500. The lock is held to the end of this
    // transaction; whoever waited looks again and finds the sequence.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${seqName}::text))`
    existing = await tx.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM pg_class WHERE relkind = 'S' AND relname = ${seqName}
    `
  }
  if (existing.length === 0) {
    // Start above whatever this company already used. Read it from the
    // invoice numbers themselves rather than from `sequenceNumber`, which is
    // null for every row written before Tier 174 added the column.
    // Tier 794: and not below the number the company said its range goes on at
    const start = Math.max((await usedMax(tx, companyId, prefix, scope)) + 1, startFloor(company?.settings, type, scope))
    await tx.$executeRawUnsafe(
      `CREATE SEQUENCE IF NOT EXISTS ${seqName} START ${start} INCREMENT 1`,
    )
  }

  // A sequence that has fallen behind the company's own numbers hands out one
  // that is already taken, and the @@unique constraint turns that into a P2002
  // nobody catches: measured on the old code, the invoice create answered
  // `500 Internal server error`. Cross-tenant traffic can no longer cause this,
  // but a restore or a direct insert still can, so the drift repairs itself
  // here instead of surfacing as a 500 at the end of a long create.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await tx.$queryRawUnsafe<Array<{ nextval: bigint }>>(
      `SELECT nextval('${seqName}') AS nextval`,
    )
    const seq = Number(r[0].nextval)
    const invoiceNumber = `${prefix}${year}-${String(seq).padStart(6, '0')}`
    // Tier 733: so is the number of an issued invoice that is gone (deleted on
    // its issue day, lost in a restore)
    const clash = await tx.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM "Invoice"
      WHERE "companyId" = ${companyId} AND "invoiceNumber" = ${invoiceNumber}
      UNION ALL
      SELECT 1 AS one FROM "RetiredInvoiceNumber"
      WHERE "companyId" = ${companyId} AND "invoiceNumber" = ${invoiceNumber}
      LIMIT 1
    `
    if (clash.length === 0) {
      return {
        invoiceNumber,
        sequencePrefix: prefix.replace(/-$/, ''),
        sequenceYear: year,
        sequenceNumber: seq,
      }
    }
    // is_called = true, so the next nextval() returns max + 1.
    await tx.$executeRawUnsafe(
      `SELECT setval('${seqName}', ${await usedMax(tx, companyId, prefix, scope)}, true)`,
    )
  }
  throw new BadRequestException(
    'Rechnungsnummer konnte nicht vergeben werden — bitte erneut versuchen.',
  )
}

/**
 * Tier 733b — prefix, year and sequence of a number as it is stored, for an
 * invoice that is re-entered under the number it was issued with.
 */
export function numberParts(invoiceNumber: string): InvoiceNumber {
  const m = /^([A-Z]+)-(\d{4})-(\d+)$/.exec(invoiceNumber || '')
  if (!m) throw new BadRequestException(`Keine Rechnungsnummer dieses Programms: ${invoiceNumber}`)
  return { invoiceNumber, sequencePrefix: m[1], sequenceYear: Number(m[2]), sequenceNumber: Number(m[3]) }
}

/**
 * Tier 406 — give a deleted invoice's number back to the series.
 *
 * InvoiceService.delete only allows removing the newest invoice of its type,
 * and says why: so the series stays *lückenlos*. That stopped being true when
 * Tier 174 moved numbering onto a SEQUENCE — nextval never goes backwards, so
 * deleting INV-…-000002 and creating the next invoice produced 000003, and the
 * book read 1, 3 (measured). Now that the sequence belongs to one company
 * (Tier 404), it can safely be set back so the next number is the one that was
 * deleted.
 *
 * The caller must only do this for a **draft**. A draft's number was never
 * given to anyone; a sent invoice's was, and handing it out again would put two
 * different documents with one number into circulation — far worse than a gap,
 * which the audit trail now explains (Tier 406).
 *
 * If another request has already taken the following number, rewinding still
 * cannot produce a duplicate: nextInvoiceNumber() checks every candidate and
 * fast-forwards past the company's max.
 */
export async function releaseInvoiceNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
  invoiceNumber: string,
): Promise<void> {
  const m = /^([A-Z]+)-(\d{4})-(\d+)$/.exec(invoiceNumber || '')
  if (!m) return
  const prefix = `${m[1]}-`
  // Tier 692: any other letters are an invoice's — the company's prefix of
  // today or of the day the number was given (INV by default)
  const fixed: Record<string, string> = { AN: 'QU', LS: 'DN', AB: 'OC', CN: 'CN', PI: 'PI', RCV: 'RCV' }
  const type = fixed[m[1]] ?? 'INV'
  const year = Number(m[2])
  const seq = Number(m[3])
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    return
  }
  if (!/^[A-Z]{2,5}$/.test(type) || !Number.isInteger(seq) || seq < 1) return
  // Tier 793: the range the company numbers in now
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { invoiceNumberContinuous: true, settings: true } })
  const continuous = company?.invoiceNumberContinuous !== false
  const scope = continuous ? null : year
  const seqName = sequenceName(type, scope, companyId)
  const exists = await tx.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one FROM pg_class WHERE relkind = 'S' AND relname = ${seqName}
  `
  if (exists.length === 0) return
  // Only step back if this really was the newest number handed out; never move
  // the sequence below a number that is still in use.
  const remainingMax = await usedMax(tx, companyId, prefix, scope)
  if (remainingMax >= seq) return
  // Tier 794: back to the highest number still used — but not below the
  // number the company set its range to go on at (a deleted first draft
  // INV-…-001000 gives 1000 back, not 6). is_called = false: next is `to`.
  const to = Math.max(remainingMax + 1, startFloor(company?.settings, type, scope))
  if (to > seq) return
  await tx.$executeRawUnsafe(`SELECT setval('${seqName}', ${to}, false)`)
}

/**
 * Tier 794 — „Nächste Rechnungsnummer“: the number the next invoice of a
 * company's range gets, chosen on the settings page (a company coming from
 * other software goes on at its own count, or starts at 1000). § 14 Abs. 4
 * Satz 1 Nr. 4 UStG asks for a number given once, not for where a range
 * starts; the numbers left out are a gap, which UStAE 14.5 Abs. 10 allows.
 * Only above the highest number the range has used — a lower one would give
 * numbers out of order, and none of them twice anyway (the clash check).
 * Invoices only (INV, with the company's prefix); in a range per year, the
 * current year's.
 */
export const MAX_START_NUMBER = 99_999_999

/** settings.invoiceNumberStart: { all: n } or { "2026": n } — the number set last; invoices only. */
function startFloor(settings: unknown, type: string, scope: number | null): number {
  if (type !== 'INV') return 1
  const map = (settings as Record<string, unknown> | null)?.invoiceNumberStart as Record<string, unknown> | undefined
  const v = Number(map?.[scope === null ? 'all' : String(scope)])
  return Number.isInteger(v) && v >= 1 ? v : 1
}

export interface NextInvoiceNumberInfo {
  /** the number the next invoice gets: INV-2026-001000 */
  invoiceNumber: string
  next: number
  /** the lowest that can be set: one above the highest used */
  minimum: number
  maximum: number
  year: number
  continuous: boolean
}

async function rangeOf(tx: Prisma.TransactionClient, companyId: string, year: number) {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new BadRequestException(`Invalid year for invoice number: ${year}`)
  }
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { invoicePrefix: true, invoiceNumberContinuous: true, settings: true } })
  if (!company) throw new BadRequestException('Firma nicht gefunden')
  const prefix = invoiceNumberPrefix('INV', company.invoicePrefix)
  const scope = company.invoiceNumberContinuous === false ? year : null
  return { company, prefix, scope, seqName: sequenceName('INV', scope, companyId) }
}

async function sequenceNext(tx: Prisma.TransactionClient, seqName: string): Promise<number | null> {
  const exists = await tx.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one FROM pg_class WHERE relkind = 'S' AND relname = ${seqName}
  `
  if (exists.length === 0) return null
  const r = await tx.$queryRawUnsafe<Array<{ last_value: bigint; is_called: boolean }>>(
    `SELECT last_value, is_called FROM ${seqName}`,
  )
  return Number(r[0].last_value) + (r[0].is_called ? 1 : 0)
}

/** What nextInvoiceNumber would give — without taking it. */
export async function peekNextInvoiceNumber(tx: Prisma.TransactionClient, companyId: string, year: number): Promise<NextInvoiceNumberInfo> {
  const { company, prefix, scope, seqName } = await rangeOf(tx, companyId, year)
  const used = await usedMax(tx, companyId, prefix, scope)
  let next = (await sequenceNext(tx, seqName)) ?? Math.max(used + 1, startFloor(company.settings, 'INV', scope))
  const format = (n: number) => `${prefix}${year}-${String(n).padStart(6, '0')}`
  // a taken one is skipped to above the highest (nextInvoiceNumber's clash check)
  const taken = await tx.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one FROM "Invoice" WHERE "companyId" = ${companyId} AND "invoiceNumber" = ${format(next)}
    UNION ALL
    SELECT 1 AS one FROM "RetiredInvoiceNumber" WHERE "companyId" = ${companyId} AND "invoiceNumber" = ${format(next)}
    LIMIT 1
  `
  if (taken.length > 0) next = used + 1
  return { invoiceNumber: format(next), next, minimum: used + 1, maximum: MAX_START_NUMBER, year, continuous: scope === null }
}

/** Set the number the next invoice gets. Returns the number it would have got before. */
export async function setNextInvoiceNumber(tx: Prisma.TransactionClient, companyId: string, year: number, next: number): Promise<{ before: NextInvoiceNumberInfo; after: NextInvoiceNumberInfo }> {
  if (!Number.isInteger(next) || next < 1 || next > MAX_START_NUMBER) {
    throw new BadRequestException(`Die nächste Rechnungsnummer ist eine ganze Zahl von 1 bis ${MAX_START_NUMBER.toLocaleString('de-DE')}.`)
  }
  // Tier 795: settings.invoiceNumberStart is written under the company's row lock
  await lockCompanyRow(tx, companyId)
  const { company, seqName, scope } = await rangeOf(tx, companyId, year)
  // the lock of the sequence's creator (Tier 783): no invoice creates it meanwhile
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${seqName}::text))`
  const before = await peekNextInvoiceNumber(tx, companyId, year)
  if (next < before.minimum) {
    throw new BadRequestException(
      `Die nächste Rechnungsnummer muss größer sein als die höchste bereits vergebene (${before.minimum - 1}) — mindestens ${before.minimum}. Eine vergebene Nummer darf nicht ein zweites Mal vergeben werden (§ 14 Abs. 4 Satz 1 Nr. 4 UStG).`,
    )
  }
  if ((await sequenceNext(tx, seqName)) === null) {
    await tx.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS ${seqName} START ${next} INCREMENT 1`)
  } else {
    await tx.$executeRawUnsafe(`SELECT setval('${seqName}', ${next}, false)`)
  }
  const settings = (company.settings && typeof company.settings === 'object' && !Array.isArray(company.settings) ? company.settings : {}) as Record<string, unknown>
  const starts = { ...((settings.invoiceNumberStart as Record<string, unknown>) ?? {}), [scope === null ? 'all' : String(scope)]: next }
  await tx.company.update({ where: { id: companyId }, data: { settings: { ...settings, invoiceNumberStart: starts } as Prisma.InputJsonValue } })
  return { before, after: await peekNextInvoiceNumber(tx, companyId, year) }
}
