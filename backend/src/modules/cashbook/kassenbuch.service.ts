import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash } from 'crypto';
import { PaymentService } from '../invoice/payment.service';

// Tier 194 — GoBD § 146 AO integrity hash for the
// Tagesabschluss. We sign over a stable, sorted
// concatenation of the close record's critical
// fields. The algorithm string is the version
// identifier so future hash format changes can be
// made (e.g. SHA-512 or a Kassen-Nachschau-aware
// digest) without breaking the verification path.
const SIGNATURE_ALGORITHM = 'SHA-256-V1'

// Build the integrity hash from a close record's
// critical fields. Returns the lower-case hex
// digest. Deterministic — same input always
// produces the same hash, which is the whole
// point of the tamper-evidence check.
function computeSignatureHash(c: {
  companyId: string
  businessDate: Date
  anfangsbestand: any
  einnahmenSum: any
  ausgabenSum: any
  umbuchungenSum: any
  endbestand: any
  physicalCount: any
  closedById: string | null
  closedAt: Date
}): string {
  // The pipe is a field separator that can't appear
  // in any of the inputs (UUIDs are hex+hyphens,
  // ISO dates have colons but no pipes, decimals
  // are digits+dot). Using a separator the input
  // can't produce means we don't have to escape.
  //
  // Important: Prisma returns Decimal columns as
  // objects (Prisma.Decimal), not as strings. Their
  // `String()` method strips trailing zeros ("0" not
  // "0.0000"), which would make the close-time
  // hash (computed from `.toFixed(4)` strings)
  // differ from the verify-time hash. We always
  // pass the values through `toFixed(4)` here so
  // both paths agree on the canonical string form.
  const payload = [
    c.companyId,
    c.businessDate.toISOString().slice(0, 10),
    Number(c.anfangsbestand).toFixed(4),
    Number(c.einnahmenSum).toFixed(4),
    Number(c.ausgabenSum).toFixed(4),
    Number(c.umbuchungenSum).toFixed(4),
    Number(c.endbestand).toFixed(4),
    Number(c.physicalCount).toFixed(4),
    c.closedById ?? '',
    c.closedAt.toISOString(),
  ].join('|')
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * Kassenbuch service — German cash journal per §146 AO.
 *
 * The Kassenbuch is the most legally-sensitive document a
 * German business keeps. After every Tagesabschluss
 * (Z-Bericht) the entries of that day become immutable —
 * the only way to correct a closed day is to book a
 * Storno (reversal) entry, which the service generates
 * for you.
 *
 * Aggregates:
 *   - per-day totals: Σ Einnahmen, Σ Ausgaben, Σ Umbuchungen
 *   - cash balance:  Anfangsbestand + Σ Einnahmen − Σ Ausgaben
 *                   (Umbuchungen net to zero on the cash side;
 *                    see Umbuchung logic below)
 *   - VAT breakdown per rate (for UStVA)
 *
 * Umbuchung handling: when a customer pays a Rechnung in
 * cash and we move the cash to the bank, the cash side
 * has an Ausgabe (cash leaves the till) and the bank
 * side has a separate bank transaction. To keep the
 * Kassenbuch aligned with the actual cash count, we
 * model Umbuchung as an Ausgabe from the till (negative
 * for Kassenbestand); the corresponding bank entry is
 * out of scope for this journal.
 */

export type CashBookEntryType = 'einnahme' | 'ausgabe' | 'umbuchung' | 'eroeffnung';

const VALID_TYPES: CashBookEntryType[] = ['einnahme', 'ausgabe', 'umbuchung', 'eroeffnung'];

/** Cash effect of an entry type: into the till (+1) or out of it (−1). */
const cashSign = (type: string) => (type === 'ausgabe' || type === 'umbuchung' ? -1 : 1);

@Injectable()
export class KassenbuchService {
  private readonly logger = new Logger(KassenbuchService.name);

  constructor(
    private prisma: PrismaService,
    private payments: PaymentService,
  ) {}

  /**
   * Throw if any of the days the caller wants to write
   * to are already closed. Lets the controller surface
   * a clean 400 instead of letting the DB insert succeed
   * and then having to clean up.
   */
  private async assertDaysOpen(companyId: string, businessDates: Date[]) {
    if (!businessDates.length) return
    const unique = Array.from(new Set(businessDates.map((d) => d.toISOString().split('T')[0])))
    const closed = await this.prisma.cashBookDailyClose.findMany({
      where: {
        companyId,
        businessDate: { in: unique.map((d) => new Date(d + 'T00:00:00.000Z')) },
      },
      select: { businessDate: true },
    })
    if (closed.length > 0) {
      const dates = closed.map((c) => c.businessDate.toISOString().split('T')[0]).join(', ')
      throw new BadRequestException(
        `Cannot modify a closed day (Tagesabschluss exists): ${dates}. ` +
        `Use a Storno-Buchung to correct instead.`,
      )
    }
  }

  /**
   * Sanity-check: only one opening entry ("eroeffnung")
   * per cash book lifetime. The DB doesn't enforce this
   * (a 2nd one is technically just a row), but the
   * service does so the user can't accidentally reset
   * the Anfangsbestand.
   */
  private async assertEroeffnung(companyId: string) {
    const existing = await this.prisma.cashBookEntry.count({
      where: { companyId, type: 'eroeffnung' },
    })
    if (existing > 0) {
      throw new BadRequestException(
        'Es existiert bereits ein Eröffnungs-Eintrag. ' +
        'Für eine Korrektur buchen Sie eine Storno-Buchung.',
      )
    }
  }

  /**
   * Tier 435 — a till cannot hold less than nothing. A Kassenbuch whose
   * balance falls below zero on any day (Kassenminusbestand) records more
   * cash leaving than there was; the tax office treats the books as not
   * orderly and may estimate (§ 158 AO). Measured before: an Ausgabe of 80 €
   * into an empty till → 201, balance −80.
   *
   * A change that takes cash out (`delta` < 0 on `date`) is refused when the
   * end-of-day balance of that day or of any later day would fall below
   * zero. A change that adds cash is always allowed, so a book that is
   * already negative can be repaired (e.g. with the missing Privateinlage).
   */
  private async assertCashNotNegative(companyId: string, date: Date, delta: number) {
    if (delta >= 0) return
    const rows = await this.prisma.cashBookEntry.groupBy({
      by: ['businessDate', 'type'],
      where: { companyId },
      _sum: { amount: true },
    })
    const dayKey = (d: Date) => d.toISOString().slice(0, 10)
    const byDay = new Map<string, number>()
    for (const r of rows) {
      const k = dayKey(r.businessDate)
      byDay.set(k, (byDay.get(k) ?? 0) + cashSign(r.type) * Math.round(Number(r._sum.amount ?? 0) * 100))
    }
    const at = dayKey(date)
    byDay.set(at, (byDay.get(at) ?? 0) + Math.round(delta * 100))
    let balance = 0
    for (const k of [...byDay.keys()].sort()) {
      balance += byDay.get(k)!
      if (k >= at && balance < 0) {
        const [y, m, d] = k.split('-')
        throw new BadRequestException(
          `Der Kassenbestand würde am ${d}.${m}.${y} negativ (${(balance / 100).toFixed(2).replace('.', ',')} €). ` +
          'Eine Kasse kann nicht weniger als nichts enthalten — fehlt eine Einnahme oder Privateinlage?',
        )
      }
    }
  }

  async listEntries(companyId: string, opts: { from?: Date; to?: Date; page?: number; pageSize?: number } = {}) {
    const where: any = { companyId }
    if (opts.from || opts.to) {
      where.businessDate = {}
      if (opts.from) where.businessDate.gte = opts.from
      if (opts.to) where.businessDate.lte = opts.to
    }
    const page = Math.max(1, opts.page || 1)
    const pageSize = Math.min(200, Math.max(1, opts.pageSize || 50))
    const [rows, total] = await Promise.all([
      this.prisma.cashBookEntry.findMany({
        where,
        orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          createdBy: { select: { id: true, email: true } },
          reversedBy: { select: { id: true, businessDate: true } },
        },
      }),
      this.prisma.cashBookEntry.count({ where }),
    ])
    // Find which dates are closed in the visible range
    const dates = Array.from(new Set(rows.map((r) => r.businessDate.toISOString().split('T')[0])))
    const closed = await this.prisma.cashBookDailyClose.findMany({
      where: { companyId, businessDate: { in: dates.map((d) => new Date(d + 'T00:00:00.000Z')) } },
      select: { businessDate: true },
    })
    const closedSet = new Set(closed.map((c) => c.businessDate.toISOString().split('T')[0]))
    return {
      data: rows.map((r) => ({ ...r, dayClosed: closedSet.has(r.businessDate.toISOString().split('T')[0]) })),
      total,
      page,
      pageSize,
    }
  }

  /**
   * Compute live cash balance as of `at`. Includes every
   * entry up to and including `at`, regardless of
   * whether the day has been closed.
   *
   * The formula:
   *   eröffnung (Anfangsbestand) + Σ einnahme − Σ ausgabe
   *   (umbuchung treated as ausgabe for the cash side)
   *
   * Returns the breakdown so the UI can show "you have
   * 12 entries (5 einnahme, 6 ausgabe, 1 umbuchung)"
   * next to the number.
   */
  async cashBalance(companyId: string, at: Date = new Date()): Promise<{
    balance: number
    anfang: number
    einnahmen: number
    ausgaben: number
    umbuchungen: number
    entryCount: number
  }> {
    const startOfDay = new Date(at)
    startOfDay.setHours(0, 0, 0, 0)
    const endOfDay = new Date(at)
    endOfDay.setHours(23, 59, 59, 999)

    const rows = await this.prisma.cashBookEntry.findMany({
      where: {
        companyId,
        businessDate: { gte: new Date('1900-01-01'), lte: endOfDay },
      },
      select: { type: true, amount: true },
    })

    let anfang = 0
    let einnahmen = 0
    let ausgaben = 0
    let umbuchungen = 0
    for (const r of rows) {
      const a = Number(r.amount)
      switch (r.type) {
        case 'eroeffnung': anfang += a; break
        case 'einnahme': einnahmen += a; break
        case 'ausgabe': ausgaben += a; break
        case 'umbuchung': umbuchungen += a; break
      }
    }
    const balance = anfang + einnahmen - ausgaben - umbuchungen
    return {
      balance: Math.round(balance * 100) / 100,
      anfang: Math.round(anfang * 100) / 100,
      einnahmen: Math.round(einnahmen * 100) / 100,
      ausgaben: Math.round(ausgaben * 100) / 100,
      umbuchungen: Math.round(umbuchungen * 100) / 100,
      entryCount: rows.length,
    }
  }

  /**
   * Compute the running balance for a given day
   * (Anfangsbestand = previous day's Endbestand,
   * Endbestand = balance after this day's entries).
   * Used by the daily-close view.
   */
  async dayBalance(companyId: string, businessDate: Date): Promise<{
    anfang: number
    einnahmen: number
    ausgaben: number
    umbuchungen: number
    ende: number
    entries: any[]
  }> {
    // Previous-day endbestand = balance at end-of-day BEFORE this one.
    // An `eroeffnung` (Anfangsbestand) row's `businessDate` IS the first
    // day of business — semantically it represents the cash on hand at
    // the START of that day, so it must count toward that day's
    // `anfang`, not the previous day's. We query prior days strictly
    // before dayStart, and ADD any eroeffnung rows from THIS day into
    // `anfang` (while making sure they're NOT also counted in the
    // `einnahmen/ausgaben` breakdown below).
    const dayStart = new Date(businessDate)
    dayStart.setUTCHours(0, 0, 0, 0)
    const dayEnd = new Date(businessDate)
    dayEnd.setUTCHours(23, 59, 59, 999)

    const priorRows = await this.prisma.cashBookEntry.findMany({
      where: { companyId, businessDate: { lt: dayStart } },
      select: { type: true, amount: true },
    })
    let anfang = 0
    for (const r of priorRows) {
      const a = Number(r.amount)
      if (r.type === 'eroeffnung' || r.type === 'einnahme') anfang += a
      else if (r.type === 'ausgabe' || r.type === 'umbuchung') anfang -= a
    }

    const today = await this.prisma.cashBookEntry.findMany({
      where: { companyId, businessDate: { gte: dayStart, lte: dayEnd } },
      orderBy: { createdAt: 'asc' },
    })
    let einnahmen = 0
    let ausgaben = 0
    let umbuchungen = 0
    for (const r of today) {
      const a = Number(r.amount)
      switch (r.type) {
        case 'eroeffnung': anfang += a; break   // Anfangsbestand goes into anfang, not einnahme
        case 'einnahme': einnahmen += a; break
        case 'ausgabe': ausgaben += a; break
        case 'umbuchung': umbuchungen += a; break
      }
    }
    const ende = anfang + einnahmen - ausgaben - umbuchungen
    return {
      anfang: Math.round(anfang * 100) / 100,
      einnahmen: Math.round(einnahmen * 100) / 100,
      ausgaben: Math.round(ausgaben * 100) / 100,
      umbuchungen: Math.round(umbuchungen * 100) / 100,
      ende: Math.round(ende * 100) / 100,
      entries: today,
    }
  }

  async createEntry(companyId: string, createdById: string | undefined, data: {
    businessDate: Date
    type: CashBookEntryType
    description: string
    amount: number
    vatRate?: number | null
    counterparty?: string | null
    belegNumber?: string | null
    expenseId?: string | null
    invoiceId?: string | null
    notes?: string | null
  }) {
    if (!VALID_TYPES.includes(data.type)) {
      throw new BadRequestException(`type must be one of ${VALID_TYPES.join(', ')}`)
    }
    if (!data.description?.trim()) {
      throw new BadRequestException('Beschreibung ist erforderlich')
    }
    if (data.amount <= 0) {
      throw new BadRequestException('Betrag muss > 0 sein')
    }
    await this.assertDaysOpen(companyId, [data.businessDate])
    // Normalise the date to midnight UTC so the DB @db.Date
    // column gets a clean value.
    const bd = new Date(data.businessDate)
    bd.setUTCHours(0, 0, 0, 0)
    await this.assertCashNotNegative(companyId, bd, cashSign(data.type) * data.amount)
    if (data.type === 'eroeffnung') {
      await this.assertEroeffnung(companyId)
    }
    // Tier 390: expenseId / invoiceId are foreign keys to this company's
    // records. Measured: company B's entry with company A's invoiceId → 201 —
    // a GoBD cash record in one company pointing at another company's invoice.
    if (data.invoiceId) {
      const inv = await this.prisma.invoice.findFirst({ where: { id: data.invoiceId, companyId }, select: { id: true } })
      if (!inv) throw new BadRequestException('Rechnung nicht gefunden')
      if (data.type !== 'einnahme') {
        throw new BadRequestException('Nur eine Einnahme kann einer Rechnung zugeordnet werden')
      }
    }
    if (data.expenseId) {
      const exp = await this.prisma.expense.findFirst({ where: { id: data.expenseId, companyId }, select: { id: true } })
      if (!exp) throw new BadRequestException('Ausgabe nicht gefunden')
      if (data.type !== 'ausgabe') {
        throw new BadRequestException('Nur eine Ausgabe kann einer Eingangsrechnung zugeordnet werden')
      }
    }
    // Tier 425: a cash receipt for an invoice is a payment of it — recorded
    // as one (status, Skonto, dunning, DATEV). Before, the invoice stayed
    // "sent" and was dunned although paid at the counter. The payment goes
    // first: PaymentService validates it, and a rejected payment leaves no
    // cash-book entry behind.
    let paymentId: string | null = null
    if (data.invoiceId) {
      const payment = await this.payments.create(data.invoiceId, companyId, {
        amount: data.amount,
        paymentDate: bd,
        paymentMethod: 'cash',
        reference: data.belegNumber || undefined,
        notes: 'Kassenbuch',
      })
      paymentId = payment.id
    }
    // A cash payment of a recorded expense dates its Abfluss.
    if (data.expenseId) {
      await this.prisma.expense.updateMany({
        where: { id: data.expenseId, companyId, paidAt: null },
        data: { paidAt: bd },
      })
    }
    return this.prisma.cashBookEntry.create({
      data: {
        companyId,
        businessDate: bd,
        type: data.type,
        description: data.description.trim(),
        amount: data.amount.toFixed(4),
        vatRate: data.vatRate === undefined ? null : (data.vatRate?.toFixed(4) ?? null),
        counterparty: data.counterparty || null,
        belegNumber: data.belegNumber || null,
        expenseId: data.expenseId || null,
        invoiceId: data.invoiceId || null,
        paymentId,
        notes: data.notes || null,
        createdById,
      },
    })
  }

  /** Tier 425: undo what a linked entry did outside the cash book. */
  private async unlink(companyId: string, entry: { paymentId: string | null; expenseId: string | null; businessDate: Date }) {
    if (entry.paymentId) {
      await this.payments.delete(entry.paymentId, companyId)
    }
    if (entry.expenseId) {
      await this.prisma.expense.updateMany({
        where: { id: entry.expenseId, companyId, paidAt: entry.businessDate },
        data: { paidAt: null },
      })
    }
  }

  async updateEntry(companyId: string, id: string, patch: {
    description?: string
    amount?: number
    vatRate?: number | null
    counterparty?: string | null
    belegNumber?: string | null
    notes?: string | null
  }) {
    const existing = await this.prisma.cashBookEntry.findFirst({ where: { id, companyId } })
    if (!existing) throw new NotFoundException('Entry not found')
    await this.assertDaysOpen(companyId, [existing.businessDate])
    if (existing.paymentId && patch.amount !== undefined && patch.amount !== Number(existing.amount)) {
      throw new BadRequestException(
        'Der Betrag einer Rechnungszahlung kann nicht geändert werden — Buchung stornieren und neu erfassen.',
      )
    }
    if (patch.amount !== undefined) {
      await this.assertCashNotNegative(
        companyId, existing.businessDate, cashSign(existing.type) * (patch.amount - Number(existing.amount)),
      )
    }
    return this.prisma.cashBookEntry.update({
      where: { id },
      data: {
        description: patch.description,
        amount: patch.amount !== undefined ? patch.amount.toFixed(4) : undefined,
        vatRate: patch.vatRate === null ? null : (patch.vatRate !== undefined ? patch.vatRate.toFixed(4) : undefined),
        counterparty: patch.counterparty,
        belegNumber: patch.belegNumber,
        notes: patch.notes,
      },
    })
  }

  async deleteEntry(companyId: string, id: string) {
    const existing = await this.prisma.cashBookEntry.findFirst({ where: { id, companyId } })
    if (!existing) throw new NotFoundException('Entry not found')
    await this.assertDaysOpen(companyId, [existing.businessDate])
    await this.assertCashNotNegative(companyId, existing.businessDate, -cashSign(existing.type) * Number(existing.amount))
    await this.unlink(companyId, existing)
    await this.prisma.cashBookEntry.delete({ where: { id } })
    return { ok: true }
  }

  /**
   * Post a Storno (reversal) for an entry. The original
   * row stays in the book; a new row is created with the
   * same amount but the same direction the original
   * flowed — net effect on the balance is zero.
   *
   * For a closed day the only way to "edit" is via this
   * route. The service marks the day's close as
   * `amendedAt = now()` so the UI can warn the user.
   */
  async reverseEntry(companyId: string, id: string, reason: string, createdById?: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('Begründung ist erforderlich für eine Storno-Buchung')
    }
    const original = await this.prisma.cashBookEntry.findFirst({ where: { id, companyId } })
    if (!original) throw new NotFoundException('Entry not found')
    if (original.reversesId) {
      throw new BadRequestException('Diese Buchung ist bereits eine Storno-Buchung und kann nicht selbst storniert werden. Stornieren Sie stattdessen die Originalbuchung.')
    }
    // Tier 376: CashBookEntry.reversesId is @unique, so a second storno of the
    // same entry failed in Postgres (P2002) and answered 500 — e2e 03 sent
    // exactly that request without asserting the status.
    const existingReversal = await this.prisma.cashBookEntry.findFirst({
      where: { reversesId: original.id },
      select: { id: true },
    })
    if (existingReversal) {
      throw new BadRequestException('Diese Buchung wurde bereits storniert.')
    }
    // The reversal carries the NEGATIVE of the original
    // amount. Same type, same vatRate — that way the row
    // stays categorically correct in the by-type breakdown
    // (an einnahme storno is still tracked under einnahmen),
    // but the negative sign means the aggregation loop
    // (`einnahmen += a`) actually subtracts it.
    //
    // Example: original einnahme 100 → reversal einnahme
    // -100 → einnahmen sum = 100 + (-100) = 0. ✓
    //
    // The previous implementation stored the reversal with
    // the same positive amount, which silently doubled
    // the einnahmen/ausgaben sum. Caught by GoBD e2e
    // test 03-storno-net-zero.sh.
    const originalAmount = Number(original.amount)
    const reversalAmount = -originalAmount
    // Tier 435: a Storno is not checked against a negative Kassenbestand. It
    // corrects a booking that was wrong, often on a closed day where nothing
    // else can be entered; refusing it would keep the wrong booking. If the
    // corrected book goes negative, the missing receipt must be booked too.
    // Tier 425: the Storno also takes back the payment the entry recorded
    // (or the expense's payment date).
    await this.unlink(companyId, original)
    const reversal = await this.prisma.cashBookEntry.create({
      data: {
        companyId,
        businessDate: original.businessDate,
        type: original.type as CashBookEntryType,
        description: `STORNO: ${original.description}`,
        amount: reversalAmount.toFixed(4),
        vatRate: original.vatRate,
        counterparty: original.counterparty,
        belegNumber: original.belegNumber,
        // Tier 425: the Storno of a linked entry stays linked, so the reports
        // treat both alike (the invoice / expense is what they count).
        invoiceId: original.invoiceId,
        expenseId: original.expenseId,
        notes: reason,
        createdById,
        reversesId: original.id,
      },
    })
    // Mark the day's close as amended, if any
    await this.prisma.cashBookDailyClose.updateMany({
      where: { companyId, businessDate: original.businessDate },
      data: { amendedAt: new Date() },
    })
    return reversal
  }

  /**
   * Z-Bericht: close one day. Captures the day's
   * aggregates + a JSON snapshot of every entry id /
   * amount, so the close is auditable even after later
   * Storno entries are added.
   *
   * The `physicalCount` is what the user types in from
   * the till. The differenz is `physicalCount − endbestand`.
   */
  async closeDay(companyId: string, businessDate: Date, physicalCount: number, closedById?: string, differenzNote?: string) {
    const bd = new Date(businessDate)
    bd.setUTCHours(0, 0, 0, 0)
    // Already closed? Refuse — the user has to delete
    // the close explicitly to re-open.
    const existing = await this.prisma.cashBookDailyClose.findFirst({
      where: { companyId, businessDate: bd },
    })
    if (existing) {
      throw new BadRequestException('Dieser Tag ist bereits abgeschlossen. Löschen Sie den Tagesabschluss, um ihn erneut zu öffnen.')
    }
    const day = await this.dayBalance(companyId, bd)
    if (day.entries.length === 0) {
      throw new BadRequestException('Keine Buchungen an diesem Tag — Z-Bericht nicht erforderlich (oder leerer Tag).')
    }
    const differenz = Math.round((physicalCount - day.ende) * 100) / 100
    // GoBD §146 AO: a non-zero cash differenz must be
    // documented at close time. Without a note we have
    // an unexplained Kassenfehlbetrag / Kassenüberschuss
    // in the audit trail, which is exactly what the
    // Betriebsprüfer will flag in the next tax audit.
    // (Caught by e2e/04-zbericht-differenz.sh.)
    if (Math.abs(differenz) > 0.001 && !differenzNote?.trim()) {
      throw new BadRequestException(
        'Bei einer Differenz ist eine Begründung erforderlich (GoBD §146 AO). ' +
        `Differenz: ${differenz} EUR. Bitte DifferenzNote angeben.`
      )
    }
    const snapshot = {
      entries: day.entries.map((e: any) => ({
        id: e.id,
        type: e.type,
        description: e.description,
        amount: Number(e.amount),
        vatRate: e.vatRate ? Number(e.vatRate) : null,
        counterparty: e.counterparty,
        belegNumber: e.belegNumber,
      })),
      totalCount: day.entries.length,
      generatedAt: new Date().toISOString(),
    }
    // Tier 194 — compute the integrity hash BEFORE
    // the create so the row is born signed. If the
    // create fails (unique violation, FK error), the
    // hash never gets persisted — the next call to
    // closeDay will re-derive and write a fresh one.
    //
    // Pass numbers (not pre-formatted strings) —
    // computeSignatureHash now canonicalises
    // them via Number(x).toFixed(4), and pre-
    // formatted strings would skip the canonical
    // pass.
    const createdAt = new Date()
    // Round to whole seconds so the hash survives
    // DB column precision. PG @db.Timestamp(3) is
    // 3 fractional digits (ms), but the value gets
    // rounded at write time (e.g. 048 → 050) which
    // would make a later verify-time hash diverge
    // from the close-time hash. Floor to second
    // boundary so both sides agree.
    const createdAtRounded = new Date(Math.floor(createdAt.getTime() / 1000) * 1000)
    const hashInputs = {
      companyId,
      businessDate: bd,
      anfangsbestand: day.anfang,
      einnahmenSum: day.einnahmen,
      ausgabenSum: day.ausgaben,
      umbuchungenSum: day.umbuchungen,
      endbestand: day.ende,
      physicalCount,
      closedById: closedById ?? null,
      closedAt: createdAtRounded,
    }
    const signatureHash = computeSignatureHash(hashInputs)
    return this.prisma.cashBookDailyClose.create({
      data: {
        companyId,
        businessDate: bd,
        anfangsbestand: day.anfang.toFixed(4),
        einnahmenSum: day.einnahmen.toFixed(4),
        ausgabenSum: day.ausgaben.toFixed(4),
        umbuchungenSum: day.umbuchungen.toFixed(4),
        endbestand: day.ende.toFixed(4),
        physicalCount: physicalCount.toFixed(4),
        differenz: differenz.toFixed(4),
        differenzNote: differenzNote || null,
        entriesSnapshot: snapshot,
        closedById,
        // Set closedAt explicitly to the same
        // rounded value we hashed. The schema
        // default is @default(now()) which uses
        // PG's `now()` and preserves ms — that
        // ms would diverge from the hash's
        // second-precision closedAt.
        closedAt: createdAtRounded,
        signatureHash,
        signatureAlgorithm: SIGNATURE_ALGORITHM,
        signatureTimestamp: createdAtRounded,
      },
    })
  }

  /**
   * Tier 194 — re-derive the integrity hash from the
   * close row's current state and assert it matches
   * the stored hash. Returns the verification result
   * (algorithm, storedHash, recomputedHash, match,
   * verifiedAt). Used by:
   *   - POST /cashbook/close-day/:id/sign  (catches
   *     tampering since the last sign)
   *   - GET  /cashbook/close-day/:id/verify (UI
   *     status indicator + audit tool)
   *
   * `verified` is true when the hashes match. A
   * `signatureHash` of null means the row was created
   * before Tier 194 (no hash on the row) — that's
   * a separate `signed=false` state, not a failure.
   */
  verifyClose(close: {
    id: string
    companyId: string
    businessDate: Date
    anfangsbestand: any
    einnahmenSum: any
    ausgabenSum: any
    umbuchungenSum: any
    endbestand: any
    physicalCount: any
    closedById: string | null
    closedAt: Date
    signatureHash: string | null
    signatureAlgorithm: string | null
    signatureTimestamp: Date | null
  }): {
    id: string
    signed: boolean
    verified: boolean
    algorithm: string | null
    storedHash: string | null
    recomputedHash: string
    signatureTimestamp: string | null
    verifiedAt: string
  } {
    const recomputed = computeSignatureHash(close)
    const signed = !!close.signatureHash
    const verified = signed && recomputed === close.signatureHash
    return {
      id: close.id,
      signed,
      verified,
      algorithm: close.signatureAlgorithm,
      storedHash: close.signatureHash,
      recomputedHash: recomputed,
      signatureTimestamp: close.signatureTimestamp?.toISOString() ?? null,
      verifiedAt: new Date().toISOString(),
    }
  }

  /**
   * Tier 194 — explicitly (re-)sign a close. Writes
   * the current hash to the row. The semantics are
   * "operator asserts this close is final and the
   * hash on disk represents the final state". If
   * the row has been mutated after creation, the
   * recomputed hash diverges and the operator
   * sees the mismatch (we return 409 Conflict
   * in that case — the controller turns the
   * mismatch into an HTTP status).
   *
   * The method is idempotent: re-signing an
   * already-signed close just updates the
   * signatureTimestamp.
   */
  async signClose(closeId: string, companyId: string): Promise<{
    id: string
    signatureHash: string
    signatureAlgorithm: string
    signatureTimestamp: string
    verification: ReturnType<KassenbuchService['verifyClose']>
  }> {
    const close = await this.prisma.cashBookDailyClose.findFirst({
      where: { id: closeId, companyId },
    })
    if (!close) {
      throw new NotFoundException('Tagesabschluss nicht gefunden')
    }
    const recomputed = computeSignatureHash(close)
    if (close.signatureHash && recomputed !== close.signatureHash) {
      throw new BadRequestException(
        'Tagesabschluss wurde seit dem letzten Signieren verändert — Hash stimmt nicht mehr. ' +
        'Bitte prüfen Sie die Buchungen. ' +
        `Gespeicherter Hash: ${close.signatureHash.slice(0, 16)}… ` +
        `Erwarteter Hash: ${recomputed.slice(0, 16)}…`
      )
    }
    const ts = new Date()
    const tsRounded = new Date(Math.floor(ts.getTime() / 1000) * 1000)
    const updated = await this.prisma.cashBookDailyClose.update({
      where: { id: closeId },
      data: {
        signatureHash: recomputed,
        signatureAlgorithm: SIGNATURE_ALGORITHM,
        signatureTimestamp: tsRounded,
      },
    })
    return {
      id: updated.id,
      signatureHash: recomputed,
      signatureAlgorithm: SIGNATURE_ALGORITHM,
      signatureTimestamp: tsRounded.toISOString(),
      verification: this.verifyClose(updated),
    }
  }

  /**
   * Tier 194 — verify by id (HTTP-layer helper).
   * Loads the close row, runs verifyClose, throws
   * NotFoundException if the id is unknown.
   * Never mutates the row.
   */
  async verifyCloseById(closeId: string, companyId: string) {
    const close = await this.prisma.cashBookDailyClose.findFirst({
      where: { id: closeId, companyId },
    })
    if (!close) {
      throw new NotFoundException('Tagesabschluss nicht gefunden')
    }
    return this.verifyClose(close)
  }

  /**
   * Tier 194 — minimal company header for the
   * Kassenabschluss PDF (name + taxId). Used by
   * the controller; kept here so the controller
   * doesn't have to spin up a second PrismaService
   * instance.
   */
  async getCompanyHeader(companyId: string): Promise<{
    name: string | null
    taxId: string | null
  }> {
    const c = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true, taxId: true },
    })
    return { name: c?.name ?? null, taxId: c?.taxId ?? null }
  }

  /**
   * Re-open a closed day by deleting the close record.
   * The entries themselves stay — they were never
   * deleted. The next Z-Bericht can re-snapshot the day.
   * We log this explicitly because it bumps a GoBD
   * audit trail entry.
   */
  async reopenDay(companyId: string, businessDate: Date) {
    const bd = new Date(businessDate)
    bd.setUTCHours(0, 0, 0, 0)
    const existing = await this.prisma.cashBookDailyClose.findFirst({
      where: { companyId, businessDate: bd },
    })
    if (!existing) {
      throw new NotFoundException('Tag ist nicht abgeschlossen')
    }
    await this.prisma.cashBookDailyClose.delete({ where: { id: existing.id } })
    this.logger.warn(`Day ${bd.toISOString().split('T')[0]} re-opened by user request (GoBD audit note)`)
    return { ok: true, reopened: true }
  }

  /**
   * Get a single day's close (Z-Bericht) for display.
   * Returns the stored aggregates + the entries that
   * were on the book at close time (from the snapshot).
   */
  async getClose(companyId: string, businessDate: Date) {
    const bd = new Date(businessDate)
    bd.setUTCHours(0, 0, 0, 0)
    const close = await this.prisma.cashBookDailyClose.findFirst({
      where: { companyId, businessDate: bd },
      include: { closedBy: { select: { id: true, email: true } } },
    })
    if (!close) throw new NotFoundException('Tagesabschluss nicht gefunden')
    return close
  }

  /**
   * List all closes in a date range (for the Z-Bericht
   * history view).
   */
  async listCloses(companyId: string, opts: { from?: Date; to?: Date } = {}) {
    const where: any = { companyId }
    if (opts.from || opts.to) {
      where.businessDate = {}
      if (opts.from) where.businessDate.gte = opts.from
      if (opts.to) where.businessDate.lte = opts.to
    }
    return this.prisma.cashBookDailyClose.findMany({
      where,
      orderBy: { businessDate: 'desc' },
      include: { closedBy: { select: { id: true, email: true } } },
    })
  }

  /**
   * Aggregate a month: total Einnahmen / Ausgaben /
   * Umbuchungen, plus per-VAT breakdown for UStVA
   * input. Useful for the monthly report.
   */
  async monthSummary(companyId: string, year: number, month: number) {
    const start = new Date(Date.UTC(year, month - 1, 1))
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999))
    const rows = await this.prisma.cashBookEntry.findMany({
      where: { companyId, businessDate: { gte: start, lte: end } },
    })
    let einnahmen = 0, ausgaben = 0, umbuchungen = 0
    const vatByRate = new Map<number, { rate: number; net: number; vat: number }>()
    for (const r of rows) {
      const a = Number(r.amount)
      if (r.type === 'einnahme') einnahmen += a
      else if (r.type === 'ausgabe') ausgaben += a
      else if (r.type === 'umbuchung') umbuchungen += a
      if (r.vatRate) {
        const rate = Number(r.vatRate)
        const net = a / (1 + rate)
        const vat = a - net
        const cur = vatByRate.get(rate) || { rate, net: 0, vat: 0 }
        cur.net += net
        cur.vat += vat
        vatByRate.set(rate, cur)
      }
    }
    return {
      year, month,
      einnahmen: Math.round(einnahmen * 100) / 100,
      ausgaben: Math.round(ausgaben * 100) / 100,
      umbuchungen: Math.round(umbuchungen * 100) / 100,
      entryCount: rows.length,
      vatBreakdown: Array.from(vatByRate.values()).map((v) => ({
        rate: v.rate,
        net: Math.round(v.net * 100) / 100,
        vat: Math.round(v.vat * 100) / 100,
        gross: Math.round((v.net + v.vat) * 100) / 100,
      })),
    }
  }
}
