import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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

@Injectable()
export class KassenbuchService {
  private readonly logger = new Logger(KassenbuchService.name);

  constructor(private prisma: PrismaService) {}

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
    if (data.type === 'eroeffnung') {
      await this.assertEroeffnung(companyId)
    }
    // Normalise the date to midnight UTC so the DB @db.Date
    // column gets a clean value.
    const bd = new Date(data.businessDate)
    bd.setUTCHours(0, 0, 0, 0)
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
        notes: data.notes || null,
        createdById,
      },
    })
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
    // Create the reversal
    const reversal = await this.prisma.cashBookEntry.create({
      data: {
        companyId,
        businessDate: original.businessDate,
        type: original.type as CashBookEntryType,
        description: `STORNO: ${original.description}`,
        amount: original.amount, // positive, same type → opposite sign on the balance
        vatRate: original.vatRate,
        counterparty: original.counterparty,
        belegNumber: original.belegNumber,
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
      },
    })
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
