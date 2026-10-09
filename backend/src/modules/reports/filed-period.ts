import { BadRequestException } from '@nestjs/common'
import { businessDayIso } from '../../common/business-date'

/**
 * Tier 537 — a submitted UStVA locks its period (decided by the user,
 * 06.10.2026).
 *
 * Until now a return that was sent to the Finanzamt locked nothing: invoices
 * and expenses of its period could be issued, changed and deleted, and the
 * history then said "Berichtigung nötig" (Tier 449). Now a document whose
 * date falls into a submitted period is refused — the correction belongs in
 * the current period (a credit note, a Storno), or the period is released on
 * purpose ("Zeitraum freigeben" in the UStVA history, `releasedAt`), changed,
 * and submitted again as a corrected return, which locks it again.
 *
 * "The date" is the one the UStVA assigns the document by: the issue date of
 * an invoice or credit note, the invoice date of an expense, the day of a
 * Kassenbuch entry that carries VAT — and, for a company with
 * Ist-Versteuerung (§ 20 UStG), the payment date of a payment.
 */
type Db = any

export interface FiledPeriod {
  id: string
  periodLabel: string
  submittedAt: Date | null
}

export async function filedPeriodOf(db: Db, companyId: string, date: Date | string | null | undefined): Promise<FiledPeriod | null> {
  if (!date) return null
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return null
  const [y, m] = businessDayIso(d).split('-').map(Number)
  return db.uStvaFiling.findFirst({
    where: {
      companyId,
      year: y,
      status: { in: ['submitted', 'accepted'] },
      releasedAt: null,
      // the month's return, the quarter's, or one saved for the whole year
      OR: [{ month: m }, { month: null, quarter: Math.ceil(m / 3) }, { month: null, quarter: null }],
    },
    select: { id: true, periodLabel: true, submittedAt: true },
  })
}

export function filedPeriodMessage(f: FiledPeriod, what: string): string {
  const when = f.submittedAt ? ` am ${businessDayIso(f.submittedAt).split('-').reverse().join('.')}` : ''
  return (
    `Die Umsatzsteuer-Voranmeldung ${f.periodLabel} wurde${when} übermittelt — ${what} in diesem Zeitraum ist gesperrt. ` +
    'Buchen Sie die Korrektur im laufenden Zeitraum (Gutschrift, Storno), oder geben Sie den Zeitraum unter ' +
    '„Umsatzsteuer → Verlauf“ frei und übermitteln Sie danach eine berichtigte Voranmeldung.'
  )
}

/** Refuses (400) when one of the dates lies in a submitted, unreleased period. */
/**
 * Tier 609 — the books are closed up to a day (Festschreibung, GoBD).
 *
 * A submitted UStVA locked the documents of its period (Tier 537); nothing
 * locked a manual voucher, and nothing closed a year. `Company.
 * booksClosedUntil` is the day up to which (inclusive) nothing is written,
 * changed or deleted any more: invoices, credit notes, payments, expenses,
 * cashbook entries, bank bookings (all through `assertPeriodOpen`), manual
 * vouchers and their corrections, and the depreciation bookings. A correction
 * belongs into the open period; the closing can be lifted on purpose
 * („Buchhaltung → Bücher abschließen“), which the audit log records.
 */
export async function booksClosedUntilOf(db: Db, companyId: string): Promise<string | null> {
  const c = await db.company.findUnique({ where: { id: companyId }, select: { booksClosedUntil: true } })
  return c?.booksClosedUntil ? new Date(c.booksClosedUntil).toISOString().slice(0, 10) : null
}

export function booksClosedMessage(closedUntil: string, what: string): string {
  return (
    `Die Bücher sind bis einschließlich ${closedUntil.split('-').reverse().join('.')} abgeschlossen (Festschreibung) — ${what} mit einem Datum in diesem Zeitraum ist gesperrt. ` +
    'Buchen Sie die Korrektur im offenen Zeitraum (Gutschrift, Storno), oder heben Sie den Abschluss unter ' +
    '„Buchhaltung → Bücher abschließen“ wieder auf.'
  )
}

/** Only the closing of the books — for what has no part in the UStVA (vouchers, depreciation). */
export async function assertBooksOpen(
  db: Db,
  companyId: string,
  dates: Array<Date | string | null | undefined>,
  what: string,
): Promise<void> {
  const closed = await booksClosedUntilOf(db, companyId)
  if (!closed) return
  for (const date of dates) {
    if (!date) continue
    const d = new Date(date)
    if (Number.isNaN(d.getTime())) continue
    if (businessDayIso(d) <= closed) throw new BadRequestException(booksClosedMessage(closed, what))
  }
}

export async function assertPeriodOpen(
  db: Db,
  companyId: string,
  dates: Array<Date | string | null | undefined>,
  what: string,
): Promise<void> {
  await assertBooksOpen(db, companyId, dates, what) // Tier 609
  for (const date of dates) {
    const filed = await filedPeriodOf(db, companyId, date)
    if (filed) throw new BadRequestException(filedPeriodMessage(filed, what))
  }
}
