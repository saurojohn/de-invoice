import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { InvoiceService } from '../invoice/invoice.service'
import { businessTodayIso } from '../../common/business-date'
import { withKeyLock } from '../../common/key-lock'

/**
 * Tier 611 — time tracking (Zeiterfassung).
 *
 * An entry is a day, a duration in minutes, a description — with or without
 * a customer and an hourly rate. The open, billable, priced entries of a
 * customer become the lines of an invoice draft (`bill`); an entry that is
 * on an invoice is neither changed nor deleted. Deleting the draft or
 * cancelling the invoice opens its entries again.
 *
 * An hour is billed as hours with two decimals (50 min → 0,83 Std), and the
 * amount is that times the rate — the same sum the invoice line shows.
 */
export const hoursOf = (minutes: number): number => Math.round((minutes / 60) * 100) / 100
export const amountOf = (minutes: number, rate: number): number => Math.round(hoursOf(minutes) * rate * 100) / 100

const isoDay = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) {
    throw new BadRequestException(`${label} muss ein Datum (JJJJ-MM-TT) sein.`)
  }
  return v
}

export type TimeEntryInput = {
  date?: unknown
  minutes?: unknown
  description?: unknown
  customerId?: unknown
  hourlyRate?: unknown
  billable?: unknown
}

@Injectable()
export class TimeEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoiceService,
  ) {}

  private readonly include = {
    customer: { select: { id: true, name: true } },
    invoice: { select: { id: true, invoiceNumber: true, status: true } },
  } as const

  /** validates what is given; with `full`, everything an entry needs must be there */
  private async parse(companyId: string, body: TimeEntryInput, full: boolean) {
    const data: {
      date?: Date
      minutes?: number
      description?: string
      customerId?: string | null
      hourlyRate?: Prisma.Decimal | null
      billable?: boolean
    } = {}
    if (!body || typeof body !== 'object') throw new BadRequestException('Der Zeiteintrag fehlt.')
    if (full || body.date !== undefined) {
      const day = isoDay(body.date, 'date')
      if (day > businessTodayIso()) throw new BadRequestException('Das Datum liegt in der Zukunft — erfasst wird gearbeitete Zeit.')
      data.date = new Date(day + 'T00:00:00Z')
    }
    if (full || body.minutes !== undefined) {
      const m = body.minutes
      if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > 24 * 60) {
        throw new BadRequestException('minutes muss eine ganze Zahl von 1 bis 1440 sein (höchstens 24 Stunden an einem Tag).')
      }
      data.minutes = m
    }
    if (full || body.description !== undefined) {
      const d = typeof body.description === 'string' ? body.description.trim() : ''
      if (!d) throw new BadRequestException('Bitte beschreiben Sie die Tätigkeit (description).')
      if (d.length > 500) throw new BadRequestException('Die Beschreibung ist länger als 500 Zeichen.')
      data.description = d
    }
    if (body.customerId !== undefined) {
      if (body.customerId === null || body.customerId === '') data.customerId = null
      else {
        if (typeof body.customerId !== 'string') throw new BadRequestException('customerId muss eine Kunden-ID oder null sein.')
        const customer = await this.prisma.customer.findFirst({ where: { id: body.customerId, companyId }, select: { id: true } })
        if (!customer) throw new BadRequestException('Der Kunde gehört nicht zu dieser Firma.')
        data.customerId = customer.id
      }
    }
    if (body.hourlyRate !== undefined) {
      if (body.hourlyRate === null) data.hourlyRate = null
      else {
        const r = body.hourlyRate
        if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 100_000 || Math.abs(r * 100 - Math.round(r * 100)) > 1e-6) {
          throw new BadRequestException('hourlyRate muss ein Betrag von 0 bis 100.000 mit höchstens zwei Nachkommastellen sein — oder null.')
        }
        data.hourlyRate = new Prisma.Decimal(r.toFixed(2))
      }
    }
    if (body.billable !== undefined) {
      if (typeof body.billable !== 'boolean') throw new BadRequestException('billable muss true oder false sein.')
      data.billable = body.billable
    }
    return data
  }

  async list(companyId: string, filter: { customerId?: string; from?: string; to?: string; state?: string }) {
    const state = filter.state || 'all'
    if (!['open', 'billed', 'all'].includes(state)) throw new BadRequestException('state muss open, billed oder all sein.')
    const where: Prisma.TimeEntryWhereInput = { companyId }
    if (filter.customerId) where.customerId = filter.customerId
    if (filter.from || filter.to) {
      where.date = {
        ...(filter.from ? { gte: new Date(isoDay(filter.from, 'from') + 'T00:00:00Z') } : {}),
        ...(filter.to ? { lte: new Date(isoDay(filter.to, 'to') + 'T00:00:00Z') } : {}),
      }
    }
    if (state === 'open') where.invoiceId = null
    if (state === 'billed') where.invoiceId = { not: null }
    const data = await this.prisma.timeEntry.findMany({
      where,
      include: this.include,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 2000,
    })
    let minutes = 0
    let openBillableMinutes = 0
    let openCents = 0
    for (const e of data) {
      minutes += e.minutes
      if (!e.invoiceId && e.billable) {
        openBillableMinutes += e.minutes
        if (e.hourlyRate !== null) openCents += Math.round(amountOf(e.minutes, Number(e.hourlyRate)) * 100)
      }
    }
    return { data, summary: { minutes, openBillableMinutes, openAmount: openCents / 100 } }
  }

  async create(companyId: string, userId: string | null, body: TimeEntryInput) {
    const data = await this.parse(companyId, body, true)
    return this.prisma.timeEntry.create({
      data: {
        companyId,
        userId,
        date: data.date!,
        minutes: data.minutes!,
        description: data.description!,
        customerId: data.customerId ?? null,
        hourlyRate: data.hourlyRate ?? null,
        billable: data.billable ?? true,
      },
      include: this.include,
    })
  }

  private async openEntry(id: string, companyId: string, verb: string) {
    const entry = await this.prisma.timeEntry.findFirst({ where: { id, companyId }, include: this.include })
    if (!entry) throw new NotFoundException('Zeiteintrag nicht gefunden')
    if (entry.invoiceId) {
      throw new BadRequestException(
        `Der Zeiteintrag ist mit ${entry.invoice?.invoiceNumber ?? 'einer Rechnung'} abgerechnet und wird nicht mehr ${verb}. ` +
        'Löschen Sie den Rechnungsentwurf oder stornieren Sie die Rechnung — dann ist der Eintrag wieder offen.',
      )
    }
    return entry
  }

  async update(id: string, companyId: string, body: TimeEntryInput) {
    await this.openEntry(id, companyId, 'geändert')
    const data = await this.parse(companyId, body, false)
    return this.prisma.timeEntry.update({ where: { id }, data, include: this.include })
  }

  async remove(id: string, companyId: string) {
    await this.openEntry(id, companyId, 'gelöscht')
    await this.prisma.timeEntry.delete({ where: { id } })
    return { deleted: true }
  }

  /**
   * The open, billable entries of a customer → the lines of an invoice
   * draft dated today, one line per entry („TT.MM.JJJJ Tätigkeit“, hours,
   * rate). With `entryIds`, exactly those — each must be open, billable,
   * this customer's and priced; without, every such entry (entries without
   * a rate are left open and counted in `skipped`).
   */
  async bill(companyId: string, body: { customerId?: unknown; entryIds?: unknown }) {
    const customerId = body?.customerId
    if (typeof customerId !== 'string' || !customerId) throw new BadRequestException('customerId ist erforderlich.')
    const ids = body?.entryIds
    if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some((x) => typeof x !== 'string'))) {
      throw new BadRequestException('entryIds muss eine Liste von 1 bis 500 Eintrags-IDs sein.')
    }
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true } })
    if (!customer) throw new BadRequestException('Der Kunde gehört nicht zu dieser Firma.')

    // one at a time per customer: two clicks must not put the same hours on two invoices
    return withKeyLock(`time-bill:${companyId}:${customerId}`, async () => {
      const candidates = await this.prisma.timeEntry.findMany({
        where: { companyId, customerId, invoiceId: null, billable: true, ...(ids ? { id: { in: ids as string[] } } : {}) },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      })
      if (ids && candidates.length !== new Set(ids as string[]).size) {
        throw new BadRequestException('Nicht jeder der gewählten Einträge ist ein offener, abrechenbarer Eintrag dieses Kunden.')
      }
      const unpriced = candidates.filter((e) => e.hourlyRate === null)
      if (ids && unpriced.length > 0) {
        throw new BadRequestException(`${unpriced.length} der gewählten Einträge haben keinen Stundensatz.`)
      }
      const entries = candidates.filter((e) => e.hourlyRate !== null)
      if (entries.length === 0) {
        throw new BadRequestException('Für diesen Kunden gibt es keine offenen, abrechenbaren Zeiten mit Stundensatz.')
      }
      const day = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('.')
      const invoice = (await this.invoices.create(companyId, {
        type: 'INV',
        customerId,
        issueDate: businessTodayIso(),
        items: entries.map((e) => ({
          description: `${day(e.date)} ${e.description}`.slice(0, 500),
          quantity: hoursOf(e.minutes),
          unit: 'Std',
          unitPrice: Number(e.hourlyRate),
          vatRate: 0.19, // create() turns this into 0 % where the company or the customer calls for it
        })),
      } as any)) as { id: string; invoiceNumber: string; subtotal: unknown; total: unknown }
      await this.prisma.timeEntry.updateMany({
        where: { companyId, id: { in: entries.map((e) => e.id) }, invoiceId: null },
        data: { invoiceId: invoice.id },
      })
      return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        entries: entries.length,
        skipped: unpriced.length,
        net: Number(invoice.subtotal),
        total: Number(invoice.total),
      }
    })
  }
}
