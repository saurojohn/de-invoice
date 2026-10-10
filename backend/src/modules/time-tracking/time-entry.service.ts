import { csvNumber } from '../../common/csv'
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { InvoiceService } from '../invoice/invoice.service'
import { businessDayIso, businessTodayIso } from '../../common/business-date'
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
 *
 * Tier 616: an entry can belong to a project (time-project.service.ts), and
 * an entry written without a rate takes the project's, else the customer's
 * default rate. Tier 617: a running timer per user; stopping it writes the
 * entry.
 */
export const hoursOf = (minutes: number): number => Math.round((minutes / 60) * 100) / 100
export const amountOf = (minutes: number, rate: number): number => Math.round(hoursOf(minutes) * rate * 100) / 100

export const isoDay = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) {
    throw new BadRequestException(`${label} muss ein Datum (JJJJ-MM-TT) sein.`)
  }
  return v
}

/** a net amount per hour: 0 … 100 000, two decimals */
export const rateOf = (v: unknown, label: string): Prisma.Decimal => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) {
    throw new BadRequestException(`${label} muss ein Betrag von 0 bis 100.000 mit höchstens zwei Nachkommastellen sein — oder null.`)
  }
  return new Prisma.Decimal(v.toFixed(2))
}

/** Tier 624: the steps a duration can be rounded to */
export const ROUNDING_STEPS = [0, 5, 6, 10, 15, 30, 60]
export type Rounding = { minutes: number; mode: 'up' | 'nearest' }
/** 37 min at "15 up" → 45; at "15 nearest" → 30 (but never 0); at most a day */
export const rounded = (minutes: number, rule: Rounding): number => {
  if (!rule.minutes) return minutes
  const steps = rule.mode === 'nearest' ? Math.max(1, Math.round(minutes / rule.minutes)) : Math.ceil(minutes / rule.minutes)
  return Math.min(24 * 60, steps * rule.minutes)
}

export type TimeEntryInput = {
  date?: unknown
  minutes?: unknown
  description?: unknown
  customerId?: unknown
  projectId?: unknown
  hourlyRate?: unknown
  billable?: unknown
}

type Parsed = {
  date?: Date
  minutes?: number
  description?: string
  customerId?: string | null
  projectId?: string | null
  hourlyRate?: Prisma.Decimal | null
  billable?: boolean
}

@Injectable()
export class TimeEntryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoiceService,
  ) {}

  private readonly include = {
    customer: { select: { id: true, name: true } },
    project: { select: { id: true, name: true } },
    invoice: { select: { id: true, invoiceNumber: true, status: true } },
  } as const

  /** validates what is given; with `full`, everything an entry needs must be there */
  private async parse(companyId: string, body: TimeEntryInput, full: boolean): Promise<Parsed> {
    const data: Parsed = {}
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
    if (body.projectId !== undefined) {
      if (body.projectId === null || body.projectId === '') data.projectId = null
      else {
        if (typeof body.projectId !== 'string') throw new BadRequestException('projectId muss eine Projekt-ID oder null sein.')
        data.projectId = body.projectId // checked against the customer in withProject()
      }
    }
    if (body.hourlyRate !== undefined) {
      data.hourlyRate = body.hourlyRate === null ? null : rateOf(body.hourlyRate, 'hourlyRate')
    }
    if (body.billable !== undefined) {
      if (typeof body.billable !== 'boolean') throw new BadRequestException('billable muss true oder false sein.')
      data.billable = body.billable
    }
    return data
  }

  /**
   * Tier 616: the entry's project is this company's, and of the entry's
   * customer — an entry without a customer takes the project's. Returns the
   * project (for its rate) or null.
   */
  private async withProject(companyId: string, entry: { customerId: string | null; projectId: string | null }) {
    if (!entry.projectId) return null
    const project = await this.prisma.timeProject.findFirst({
      where: { id: entry.projectId, companyId },
      select: { id: true, customerId: true, hourlyRate: true, name: true, timeRoundingMinutes: true, timeRoundingMode: true },
    })
    if (!project) throw new BadRequestException('Das Projekt gehört nicht zu dieser Firma.')
    if (project.customerId) {
      if (entry.customerId && entry.customerId !== project.customerId) {
        throw new BadRequestException(`Das Projekt „${project.name}“ gehört zu einem anderen Kunden.`)
      }
      entry.customerId = project.customerId
    }
    return project
  }

  /** Tier 616: the rate an entry starts with — the project's, else the customer's default, else none */
  private async defaultRate(companyId: string, customerId: string | null, project: { hourlyRate: Prisma.Decimal | null } | null) {
    if (project?.hourlyRate != null) return project.hourlyRate
    if (!customerId) return null
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { defaultHourlyRate: true } })
    return customer?.defaultHourlyRate ?? null
  }

  private where(companyId: string, filter: { customerId?: string; projectId?: string; invoiceId?: string; from?: string; to?: string; state?: string }) {
    const state = filter.state || 'all'
    if (!['open', 'billed', 'all'].includes(state)) throw new BadRequestException('state muss open, billed oder all sein.')
    const where: Prisma.TimeEntryWhereInput = { companyId }
    if (filter.customerId) where.customerId = filter.customerId
    if (filter.projectId) where.projectId = filter.projectId
    if (filter.from || filter.to) {
      where.date = {
        ...(filter.from ? { gte: new Date(isoDay(filter.from, 'from') + 'T00:00:00Z') } : {}),
        ...(filter.to ? { lte: new Date(isoDay(filter.to, 'to') + 'T00:00:00Z') } : {}),
      }
    }
    if (state === 'open') where.invoiceId = null
    if (state === 'billed') where.invoiceId = { not: null }
    if (filter.invoiceId) where.invoiceId = filter.invoiceId
    return where
  }

  async list(companyId: string, filter: { customerId?: string; projectId?: string; invoiceId?: string; from?: string; to?: string; state?: string }) {
    const data = await this.prisma.timeEntry.findMany({
      where: this.where(companyId, filter),
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

  /** Tier 618: the entries of a time sheet, oldest first, with what heads it */
  async timesheet(companyId: string, filter: { customerId?: string; projectId?: string; invoiceId?: string; from?: string; to?: string; state?: string }) {
    const [entries, company, customer, project, invoice] = await Promise.all([
      this.prisma.timeEntry.findMany({
        where: this.where(companyId, filter),
        include: this.include,
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        take: 5000,
      }),
      this.prisma.company.findUnique({ where: { id: companyId }, select: { name: true, address: true } }),
      filter.customerId
        ? this.prisma.customer.findFirst({ where: { id: filter.customerId, companyId }, select: { name: true, customerNumber: true } })
        : Promise.resolve(null),
      filter.projectId
        ? this.prisma.timeProject.findFirst({ where: { id: filter.projectId, companyId }, select: { name: true } })
        : Promise.resolve(null),
      filter.invoiceId
        ? this.prisma.invoice.findFirst({
            where: { id: filter.invoiceId, companyId },
            select: { invoiceNumber: true, customer: { select: { name: true, customerNumber: true } } },
          })
        : Promise.resolve(null),
    ])
    if (filter.invoiceId && !invoice) throw new NotFoundException('Rechnung nicht gefunden')
    if (filter.customerId && !customer) throw new NotFoundException('Kunde nicht gefunden')
    if (filter.projectId && !project) throw new NotFoundException('Projekt nicht gefunden')
    return {
      entries,
      company,
      customer: customer ?? invoice?.customer ?? null,
      project,
      invoiceNumber: invoice?.invoiceNumber ?? null,
      from: filter.from ?? null,
      to: filter.to ?? null,
    }
  }

  // ───────────────────────── Tier 624: the rounding rule ─────────────────────────

  /** the company's rule: `Company.settings.timeRounding`, or none */
  async rounding(companyId: string): Promise<Rounding> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } })
    const r = ((company?.settings ?? {}) as { timeRounding?: { minutes?: unknown; mode?: unknown } }).timeRounding
    const minutes = typeof r?.minutes === 'number' && ROUNDING_STEPS.includes(r.minutes) ? r.minutes : 0
    return { minutes, mode: r?.mode === 'nearest' ? 'nearest' : 'up' }
  }

  async setRounding(companyId: string, body: { minutes?: unknown; mode?: unknown }) {
    if (typeof body?.minutes !== 'number' || !ROUNDING_STEPS.includes(body.minutes)) {
      throw new BadRequestException(`minutes muss einer der Werte ${ROUNDING_STEPS.join(', ')} sein (0 = nicht runden).`)
    }
    if (body.mode !== undefined && body.mode !== 'up' && body.mode !== 'nearest') {
      throw new BadRequestException('mode muss up (aufrunden) oder nearest (kaufmännisch) sein.')
    }
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { settings: true } })
    if (!company) throw new NotFoundException('Firma nicht gefunden')
    const rule: Rounding = { minutes: body.minutes, mode: body.mode === 'nearest' ? 'nearest' : 'up' }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { settings: { ...((company.settings ?? {}) as Record<string, unknown>), timeRounding: rule } },
    })
    return rule
  }

  /**
   * Tier 626: the rule a duration is rounded by — the project's own, else
   * the customer's own, else the company's. A rule of 0 minutes says "do not
   * round" and ends the search like any other.
   */
  async roundingFor(
    companyId: string,
    customerId: string | null,
    project: { timeRoundingMinutes: number | null; timeRoundingMode: string | null } | null,
  ): Promise<Rounding> {
    const own = (r: { timeRoundingMinutes: number | null; timeRoundingMode: string | null } | null | undefined): Rounding | null =>
      r && r.timeRoundingMinutes !== null && ROUNDING_STEPS.includes(r.timeRoundingMinutes)
        ? { minutes: r.timeRoundingMinutes, mode: r.timeRoundingMode === 'nearest' ? 'nearest' : 'up' }
        : null
    const ofProject = own(project)
    if (ofProject) return ofProject
    if (customerId) {
      const ofCustomer = own(
        await this.prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { timeRoundingMinutes: true, timeRoundingMode: true } }),
      )
      if (ofCustomer) return ofCustomer
    }
    return this.rounding(companyId)
  }

  async create(companyId: string, userId: string | null, body: TimeEntryInput, pauses?: { count: number; seconds: number }) {
    const data = await this.parse(companyId, body, true)
    const entry = { customerId: data.customerId ?? null, projectId: data.projectId ?? null }
    const project = await this.withProject(companyId, entry)
    // Tier 624 / 626: a duration is written as the project, the customer or the company rounds it
    data.minutes = rounded(data.minutes!, await this.roundingFor(companyId, entry.customerId, project))
    return this.prisma.timeEntry.create({
      data: {
        companyId,
        userId,
        date: data.date!,
        minutes: data.minutes!,
        description: data.description!,
        customerId: entry.customerId,
        projectId: entry.projectId,
        // Tier 616: no rate given → the project's, else the customer's; null given → none
        hourlyRate: data.hourlyRate !== undefined ? data.hourlyRate : await this.defaultRate(companyId, entry.customerId, project),
        billable: data.billable ?? true,
        // Tier 627: what a timer hands over
        pauseCount: pauses?.count ?? 0,
        pausedSeconds: pauses?.seconds ?? 0,
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
    const existing = await this.openEntry(id, companyId, 'geändert')
    const data = await this.parse(companyId, body, false)
    let project: Awaited<ReturnType<TimeEntryService['withProject']>> | undefined
    if (data.customerId !== undefined || data.projectId !== undefined) {
      const entry = {
        customerId: data.customerId !== undefined ? data.customerId : existing.customerId,
        projectId: data.projectId !== undefined ? data.projectId : existing.projectId,
      }
      // a new customer without a word about the project: the old project does not follow
      if (data.customerId !== undefined && data.projectId === undefined && entry.projectId) {
        const old = await this.prisma.timeProject.findFirst({ where: { id: entry.projectId, companyId }, select: { customerId: true } })
        if (old?.customerId && old.customerId !== entry.customerId) entry.projectId = null
      }
      project = await this.withProject(companyId, entry)
      data.customerId = entry.customerId
      data.projectId = entry.projectId
    }
    if (data.minutes !== undefined) {
      // by the rule of where the entry is (after this change)
      const customerId = data.customerId !== undefined ? data.customerId : existing.customerId
      const projectId = data.projectId !== undefined ? data.projectId : existing.projectId
      if (project === undefined) project = await this.withProject(companyId, { customerId, projectId })
      data.minutes = rounded(data.minutes, await this.roundingFor(companyId, customerId, project))
    }
    return this.prisma.timeEntry.update({ where: { id }, data, include: this.include })
  }

  async remove(id: string, companyId: string) {
    await this.openEntry(id, companyId, 'gelöscht')
    await this.prisma.timeEntry.delete({ where: { id } })
    return { deleted: true }
  }

  /**
   * The open, billable entries of a customer → the lines of an invoice
   * draft dated today, one line per entry („TT.MM.JJJJ Projekt: Tätigkeit“,
   * hours, rate). With `entryIds`, exactly those — each must be open,
   * billable, this customer's and priced; without, every such entry (of the
   * project, if one is named; entries without a rate are left open and
   * counted in `skipped`).
   */
  async bill(companyId: string, body: { customerId?: unknown; entryIds?: unknown; projectId?: unknown }) {
    const customerId = body?.customerId
    if (typeof customerId !== 'string' || !customerId) throw new BadRequestException('customerId ist erforderlich.')
    const ids = body?.entryIds
    if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some((x) => typeof x !== 'string'))) {
      throw new BadRequestException('entryIds muss eine Liste von 1 bis 500 Eintrags-IDs sein.')
    }
    const projectId = body?.projectId
    if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
      throw new BadRequestException('projectId muss eine Projekt-ID sein.')
    }
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true } })
    if (!customer) throw new BadRequestException('Der Kunde gehört nicht zu dieser Firma.')

    // one at a time per customer: two clicks must not put the same hours on two invoices
    return withKeyLock(`time-bill:${companyId}:${customerId}`, async () => {
      const candidates = await this.prisma.timeEntry.findMany({
        where: {
          companyId,
          customerId,
          invoiceId: null,
          billable: true,
          ...(ids ? { id: { in: ids as string[] } } : {}),
          ...(projectId ? { projectId: projectId as string } : {}),
        },
        include: { project: { select: { name: true } } },
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
          description: `${day(e.date)} ${e.project ? `${e.project.name}: ` : ''}${e.description}`.slice(0, 500),
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

  // ───────────────────────── Tier 617: the timer ─────────────────────────

  private async timerOf(companyId: string, userId: string) {
    const timer = await this.prisma.runningTimer.findFirst({ where: { companyId, userId } })
    if (!timer) return null
    return { ...timer, paused: timer.pausedAt !== null, elapsedSeconds: Math.floor(TimeEntryService.elapsedMs(timer) / 1000) }
  }

  /** Tier 623: the time a timer has run — up to now, or up to its pause — without its pauses */
  private static elapsedMs(timer: { startedAt: Date; pausedAt: Date | null; pausedSeconds: number }): number {
    return Math.max(0, (timer.pausedAt ?? new Date()).getTime() - timer.startedAt.getTime() - timer.pausedSeconds * 1000)
  }

  async pauseTimer(companyId: string, userId: string | null) {
    const user = this.user(userId)
    return withKeyLock(`timer:${companyId}:${user}`, async () => {
      const timer = await this.prisma.runningTimer.findFirst({ where: { companyId, userId: user } })
      if (!timer) throw new BadRequestException('Es läuft kein Timer.')
      if (timer.pausedAt) throw new BadRequestException('Der Timer ist bereits angehalten.')
      await this.prisma.runningTimer.update({ where: { id: timer.id }, data: { pausedAt: new Date() } })
      return { running: await this.timerOf(companyId, user) }
    })
  }

  async resumeTimer(companyId: string, userId: string | null) {
    const user = this.user(userId)
    return withKeyLock(`timer:${companyId}:${user}`, async () => {
      const timer = await this.prisma.runningTimer.findFirst({ where: { companyId, userId: user } })
      if (!timer) throw new BadRequestException('Es läuft kein Timer.')
      if (!timer.pausedAt) throw new BadRequestException('Der Timer läuft — er ist nicht angehalten.')
      const pause = Math.max(0, Math.round((Date.now() - timer.pausedAt.getTime()) / 1000))
      await this.prisma.runningTimer.update({
        where: { id: timer.id },
        // Tier 627: a pause that has ended is counted
        data: { pausedAt: null, pausedSeconds: timer.pausedSeconds + pause, pauseCount: timer.pauseCount + 1 },
      })
      return { running: await this.timerOf(companyId, user) }
    })
  }

  private user(userId: string | null): string {
    if (!userId) throw new BadRequestException('Der Timer gehört zu einem Benutzer — keiner ist angemeldet.')
    return userId
  }

  async timer(companyId: string, userId: string | null) {
    return { running: await this.timerOf(companyId, this.user(userId)) }
  }

  /** one timer per user: a second start is refused, not a second clock */
  async startTimer(companyId: string, userId: string | null, body: TimeEntryInput) {
    const user = this.user(userId)
    return withKeyLock(`timer:${companyId}:${user}`, async () => {
      if (await this.prisma.runningTimer.findFirst({ where: { companyId, userId: user }, select: { id: true } })) {
        throw new BadRequestException('Es läuft bereits ein Timer — stoppen oder verwerfen Sie ihn zuerst.')
      }
      const data = await this.parse(companyId, { customerId: body?.customerId, projectId: body?.projectId }, false)
      const entry = { customerId: data.customerId ?? null, projectId: data.projectId ?? null }
      await this.withProject(companyId, entry)
      const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 500) : ''
      await this.prisma.runningTimer.create({
        data: { companyId, userId: user, customerId: entry.customerId, projectId: entry.projectId, description },
      })
      return { running: await this.timerOf(companyId, user) }
    })
  }

  /**
   * Stops the timer and writes the entry: dated the (German) day it was
   * started, the elapsed time in whole minutes (at least one, at most a
   * day — `capped` says when it was cut). What the body names overrides
   * what the timer was started with.
   */
  async stopTimer(companyId: string, userId: string | null, body: TimeEntryInput) {
    const user = this.user(userId)
    return withKeyLock(`timer:${companyId}:${user}`, async () => {
      const timer = await this.prisma.runningTimer.findFirst({ where: { companyId, userId: user } })
      if (!timer) throw new BadRequestException('Es läuft kein Timer.')
      const elapsed = Math.round(TimeEntryService.elapsedMs(timer) / 60_000)
      const minutes = Math.min(24 * 60, Math.max(1, elapsed))
      const entry = await this.create(companyId, user, {
        date: businessDayIso(timer.startedAt),
        minutes,
        description: typeof body?.description === 'string' && body.description.trim() ? body.description : timer.description,
        customerId: body?.customerId !== undefined ? body.customerId : timer.customerId,
        projectId: body?.projectId !== undefined ? body.projectId : timer.projectId,
        ...(body?.hourlyRate !== undefined ? { hourlyRate: body.hourlyRate } : {}),
        ...(body?.billable !== undefined ? { billable: body.billable } : {}),
        // Tier 627: the pauses that ended go with the entry (a stop during a
        // pause ends the work at the pause — that pause is no break in it)
      }, { count: timer.pauseCount, seconds: timer.pausedSeconds })
      await this.prisma.runningTimer.delete({ where: { id: timer.id } })
      return { entry, capped: elapsed > 24 * 60 }
    })
  }

  async discardTimer(companyId: string, userId: string | null) {
    const user = this.user(userId)
    const { count } = await this.prisma.runningTimer.deleteMany({ where: { companyId, userId: user } })
    return { discarded: count > 0 }
  }

  // ───────────────────────── Tier 625: who worked how much ─────────────────────────

  /**
   * The hours of a period, by employee, customer or project: all, billable,
   * billed and open, and what the billable hours are worth at their rates.
   */
  async report(companyId: string, filter: { from?: string; to?: string; groupBy?: string }) {
    const groupBy = filter.groupBy || 'user'
    if (!['user', 'customer', 'project'].includes(groupBy)) throw new BadRequestException('groupBy muss user, customer oder project sein.')
    const entries = await this.prisma.timeEntry.findMany({
      where: this.where(companyId, { from: filter.from, to: filter.to }),
      select: {
        userId: true, customerId: true, projectId: true, minutes: true, billable: true, invoiceId: true, hourlyRate: true,
        customer: { select: { name: true } }, project: { select: { name: true } },
      },
      take: 50_000,
    })
    type Row = { key: string | null; name: string; entries: number; minutes: number; billableMinutes: number; billedMinutes: number; openMinutes: number; billedCents: number; openCents: number }
    const rows = new Map<string, Row>()
    for (const e of entries) {
      const key = groupBy === 'user' ? e.userId : groupBy === 'customer' ? e.customerId : e.projectId
      const name = groupBy === 'customer' ? e.customer?.name ?? '' : groupBy === 'project' ? e.project?.name ?? '' : ''
      const row = rows.get(key ?? '') ?? { key: key ?? null, name, entries: 0, minutes: 0, billableMinutes: 0, billedMinutes: 0, openMinutes: 0, billedCents: 0, openCents: 0 }
      row.entries += 1
      row.minutes += e.minutes
      if (e.billable) {
        row.billableMinutes += e.minutes
        const cents = e.hourlyRate === null ? 0 : Math.round(amountOf(e.minutes, Number(e.hourlyRate)) * 100)
        if (e.invoiceId) { row.billedMinutes += e.minutes; row.billedCents += cents }
        else { row.openMinutes += e.minutes; row.openCents += cents }
      }
      rows.set(key ?? '', row)
    }
    if (groupBy === 'user') {
      const ids = [...rows.values()].map((r) => r.key).filter((k): k is string => !!k)
      // only names of users of this company
      const users = ids.length
        ? await this.prisma.user.findMany({
            where: { id: { in: ids }, OR: [{ companyId }, { userCompanies: { some: { companyId } } }] },
            select: { id: true, email: true, profile: true },
          })
        : []
      const nameOf = new Map(users.map((u) => [u.id, (((u.profile ?? {}) as { name?: unknown }).name as string) || u.email]))
      for (const r of rows.values()) r.name = r.key ? nameOf.get(r.key) ?? '' : ''
    }
    const out = [...rows.values()]
      .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'de'))
      .map(({ billedCents, openCents, ...r }) => ({ ...r, billedAmount: billedCents / 100, openAmount: openCents / 100 }))
    const total = out.reduce(
      (t, r) => ({
        entries: t.entries + r.entries, minutes: t.minutes + r.minutes, billableMinutes: t.billableMinutes + r.billableMinutes,
        billedMinutes: t.billedMinutes + r.billedMinutes, openMinutes: t.openMinutes + r.openMinutes,
        billedAmount: Math.round((t.billedAmount + r.billedAmount) * 100) / 100, openAmount: Math.round((t.openAmount + r.openAmount) * 100) / 100,
      }),
      { entries: 0, minutes: 0, billableMinutes: 0, billedMinutes: 0, openMinutes: 0, billedAmount: 0, openAmount: 0 },
    )
    return { groupBy, from: filter.from ?? null, to: filter.to ?? null, rows: out, total }
  }

  /**
   * Tier 628: the report as a CSV — semicolons, a BOM for Excel, hours as
   * decimals. A name that begins like a formula is written with a leading
   * apostrophe (a customer may be called "=SUMME(…)").
   */
  async reportCsv(companyId: string, filter: { from?: string; to?: string; groupBy?: string }): Promise<{ csv: string; filename: string }> {
    const r = await this.report(companyId, filter)
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const text = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s)
    // Tier 648: hours and amounts with a comma (common/csv.ts)
    const hours = (minutes: number) => csvNumber(Math.round((minutes / 60) * 100) / 100)
    const first = r.groupBy === 'customer' ? 'Kunde' : r.groupBy === 'project' ? 'Projekt' : 'Mitarbeiter'
    const header = [first, 'Einträge', 'Stunden', 'davon abrechenbar', 'davon abgerechnet', 'davon offen', 'abgerechnet EUR', 'offen EUR']
    const line = (name: string, x: { entries: number; minutes: number; billableMinutes: number; billedMinutes: number; openMinutes: number; billedAmount: number; openAmount: number }) =>
      [text(name), x.entries, hours(x.minutes), hours(x.billableMinutes), hours(x.billedMinutes), hours(x.openMinutes), csvNumber(x.billedAmount), csvNumber(x.openAmount)].map(cell).join(';')
    const none = r.groupBy === 'customer' ? '(ohne Kunde)' : r.groupBy === 'project' ? '(ohne Projekt)' : '(unbekannt)'
    const csv = '\uFEFF' + [header.map(cell).join(';'), ...r.rows.map((x) => line(x.name || none, x)), line('Summe', r.total)].join('\n') + '\n'
    return { csv, filename: `Zeitauswertung_${r.groupBy}_${r.from ?? 'alle'}_${r.to ?? 'alle'}.csv` }
  }
}
