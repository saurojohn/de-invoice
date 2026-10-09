import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { ROUNDING_STEPS, rateOf } from './time-entry.service'

/**
 * Tier 616 — projects below the customer.
 *
 * A project has a name, optionally a customer (none = internal), a rate of
 * its own (else the customer's default applies to its hours) and a budget
 * in hours. The list states the hours logged, so the budget can be read
 * against them. A project with hours is archived, not deleted — and keeps
 * its customer.
 */
export type TimeProjectInput = {
  name?: unknown
  customerId?: unknown
  hourlyRate?: unknown
  budgetHours?: unknown
  active?: unknown
  timeRoundingMinutes?: unknown
  timeRoundingMode?: unknown
}

@Injectable()
export class TimeProjectService {
  constructor(private readonly prisma: PrismaService) {}

  private async parse(companyId: string, body: TimeProjectInput, full: boolean) {
    const data: {
      name?: string
      customerId?: string | null
      hourlyRate?: Prisma.Decimal | null
      budgetHours?: Prisma.Decimal | null
      active?: boolean
      timeRoundingMinutes?: number | null
      timeRoundingMode?: string | null
    } = {}
    if (!body || typeof body !== 'object') throw new BadRequestException('Das Projekt fehlt.')
    if (full || body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) throw new BadRequestException('Bitte geben Sie dem Projekt einen Namen (name).')
      if (name.length > 120) throw new BadRequestException('Der Projektname ist länger als 120 Zeichen.')
      data.name = name
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
    if (body.hourlyRate !== undefined) data.hourlyRate = body.hourlyRate === null ? null : rateOf(body.hourlyRate, 'hourlyRate')
    if (body.budgetHours !== undefined) {
      const b = body.budgetHours
      if (b === null) data.budgetHours = null
      else {
        if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 1_000_000 || Math.abs(b * 100 - Math.round(b * 100)) > 1e-6) {
          throw new BadRequestException('budgetHours muss eine Stundenzahl über 0 mit höchstens zwei Nachkommastellen sein — oder null.')
        }
        data.budgetHours = new Prisma.Decimal(b.toFixed(2))
      }
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new BadRequestException('active muss true oder false sein.')
      data.active = body.active
    }
    // Tier 626: the project's own rounding rule
    if (body.timeRoundingMinutes !== undefined) {
      const m = body.timeRoundingMinutes
      if (m !== null && (typeof m !== 'number' || !ROUNDING_STEPS.includes(m))) {
        throw new BadRequestException(`timeRoundingMinutes muss einer der Werte ${ROUNDING_STEPS.join(', ')} sein — oder null (wie beim Kunden).`)
      }
      data.timeRoundingMinutes = m as number | null
    }
    if (body.timeRoundingMode !== undefined) {
      const mode = body.timeRoundingMode
      if (mode !== null && mode !== 'up' && mode !== 'nearest') throw new BadRequestException('timeRoundingMode muss up oder nearest sein — oder null.')
      data.timeRoundingMode = mode as string | null
    }
    return data
  }

  /** a name once per customer (and once among the internal ones) */
  private async assertNameFree(companyId: string, name: string, customerId: string | null, exceptId?: string) {
    const twin = await this.prisma.timeProject.findFirst({
      where: { companyId, customerId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    })
    if (twin) throw new BadRequestException(`Ein Projekt „${name}“ gibt es für diesen Kunden schon.`)
  }

  async list(companyId: string, filter: { customerId?: string; includeInactive?: boolean }) {
    const projects = await this.prisma.timeProject.findMany({
      where: {
        companyId,
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.includeInactive ? {} : { active: true }),
      },
      include: { customer: { select: { id: true, name: true, defaultHourlyRate: true } } },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      take: 1000,
    })
    const sums = projects.length
      ? await this.prisma.timeEntry.groupBy({
          by: ['projectId', 'invoiceId'],
          where: { companyId, projectId: { in: projects.map((p) => p.id) } },
          _sum: { minutes: true },
        })
      : []
    const minutesOf = new Map<string, { all: number; open: number }>()
    for (const s of sums) {
      const m = minutesOf.get(s.projectId as string) ?? { all: 0, open: 0 }
      m.all += s._sum.minutes ?? 0
      if (s.invoiceId === null) m.open += s._sum.minutes ?? 0
      minutesOf.set(s.projectId as string, m)
    }
    return {
      data: projects.map((p) => ({
        ...p,
        // what an hour on this project costs when nothing else is said
        effectiveRate: p.hourlyRate ?? p.customer?.defaultHourlyRate ?? null,
        minutes: minutesOf.get(p.id)?.all ?? 0,
        openMinutes: minutesOf.get(p.id)?.open ?? 0,
      })),
    }
  }

  async create(companyId: string, body: TimeProjectInput) {
    const data = await this.parse(companyId, body, true)
    await this.assertNameFree(companyId, data.name!, data.customerId ?? null)
    return this.prisma.timeProject.create({
      data: {
        companyId,
        name: data.name!,
        customerId: data.customerId ?? null,
        hourlyRate: data.hourlyRate ?? null,
        budgetHours: data.budgetHours ?? null,
        active: data.active ?? true,
        timeRoundingMinutes: data.timeRoundingMinutes ?? null,
        timeRoundingMode: data.timeRoundingMode ?? null,
      },
    })
  }

  async update(id: string, companyId: string, body: TimeProjectInput) {
    const existing = await this.prisma.timeProject.findFirst({ where: { id, companyId } })
    if (!existing) throw new NotFoundException('Projekt nicht gefunden')
    const data = await this.parse(companyId, body, false)
    if (data.customerId !== undefined && data.customerId !== existing.customerId) {
      const logged = await this.prisma.timeEntry.count({ where: { companyId, projectId: id } })
      if (logged > 0) {
        throw new BadRequestException(`Auf das Projekt sind ${logged} Zeiteinträge erfasst — der Kunde lässt sich nicht mehr ändern.`)
      }
    }
    if (data.name !== undefined || data.customerId !== undefined) {
      await this.assertNameFree(companyId, data.name ?? existing.name, data.customerId !== undefined ? data.customerId : existing.customerId, id)
    }
    return this.prisma.timeProject.update({ where: { id }, data })
  }

  async remove(id: string, companyId: string) {
    const existing = await this.prisma.timeProject.findFirst({ where: { id, companyId }, select: { id: true } })
    if (!existing) throw new NotFoundException('Projekt nicht gefunden')
    const logged = await this.prisma.timeEntry.count({ where: { companyId, projectId: id } })
    if (logged > 0) {
      throw new BadRequestException(`Auf das Projekt sind ${logged} Zeiteinträge erfasst — archivieren Sie es (active: false), statt es zu löschen.`)
    }
    await this.prisma.timeProject.delete({ where: { id } })
    return { deleted: true }
  }
}
