import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { isKapitalgesellschaft, resolveRechtsform } from '../company/rechtsform'
import { CreateCompanyCarDto, EndCompanyCarDto } from './company-car.dto'
import { DEFAULT_COMMUTE_DAYS, privateCarUse, reducedRateProblem, roundedListPrice } from './private-use'
import { assertPeriodOpen } from '../reports/filed-period'
import { businessTodayDate } from '../../common/business-date'

/** Tier 502 — company cars used privately (private-use.ts). */
/**
 * Tier 956 — the last day of every month from `from` to `to` (both included).
 * The private use of a car is in each month's UStVA (an unpaid supply,
 * § 3 Abs. 9a Nr. 1 UStG) and in its year's EÜR.
 */
function monthEnds(from: Date, to: Date): Date[] {
  const out: Date[] = []
  let y = from.getUTCFullYear()
  let m = from.getUTCMonth()
  const endY = to.getUTCFullYear()
  const endM = to.getUTCMonth()
  while ((y < endY || (y === endY && m <= endM)) && out.length < 600) {
    out.push(new Date(Date.UTC(y, m + 1, 0)))
    m++
    if (m > 11) { m = 0; y++ }
  }
  return out
}

@Injectable()
export class CompanyCarService {
  constructor(private prisma: PrismaService) {}

  async list(companyId: string) {
    return this.prisma.companyCar.findMany({ where: { companyId }, orderBy: { fromDate: 'asc' } })
  }

  async create(companyId: string, dto: CreateCompanyCarDto) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true, legalName: true, rechtsform: true, settings: true },
    })
    if (!company) throw new NotFoundException('Firma nicht gefunden')
    if (isKapitalgesellschaft(resolveRechtsform(company).rechtsform)) {
      throw new BadRequestException(
        'Bei einer Kapitalgesellschaft ist die private Nutzung eines Firmenwagens durch den Geschäftsführer ' +
        'Arbeitslohn (geldwerter Vorteil) — das gehört in die Lohnabrechnung, nicht hierher.',
      )
    }
    const from = new Date(dto.fromDate)
    const until = dto.untilDate ? new Date(dto.untilDate) : null
    if (until && until < from) throw new BadRequestException('Das Ende liegt vor dem Beginn.')
    const rateProblem = reducedRateProblem(dto.method, dto.listPrice, from) // Tier 905
    if (rateProblem) throw new BadRequestException(rateProblem)
    // Tier 956: its private use from its first month on — not into a submitted month or closed books
    await assertPeriodOpen(this.prisma, companyId, monthEnds(from, until ?? businessTodayDate()), 'das Erfassen eines Firmenwagens')
    return this.prisma.companyCar.create({
      data: {
        companyId,
        name: dto.name.trim(),
        listPrice: Math.round(dto.listPrice * 100) / 100,
        method: dto.method,
        fromDate: from,
        untilDate: until,
        commuteKm: dto.commuteKm ?? null, // Tier 541
        commuteDays: dto.commuteKm ? dto.commuteDays ?? DEFAULT_COMMUTE_DAYS : null,
      },
    })
  }

  async end(companyId: string, id: string, dto: EndCompanyCarDto) {
    const car = await this.prisma.companyCar.findFirst({ where: { id, companyId } })
    if (!car) throw new NotFoundException('Firmenwagen nicht gefunden')
    // Tier 541: `untilDate` only when it is part of the request — the route
    // also sets the trips home – business.
    const data: Record<string, unknown> = {}
    if (dto.untilDate !== undefined) {
      const until = dto.untilDate ? new Date(dto.untilDate) : null
      if (until && until < car.fromDate) throw new BadRequestException('Das Ende liegt vor dem Beginn.')
      data.untilDate = until
    }
    if (dto.commuteKm !== undefined) {
      data.commuteKm = dto.commuteKm ?? null
      data.commuteDays = dto.commuteKm ? dto.commuteDays ?? car.commuteDays ?? DEFAULT_COMMUTE_DAYS : null
    } else if (dto.commuteDays !== undefined && car.commuteKm) {
      data.commuteDays = dto.commuteDays ?? DEFAULT_COMMUTE_DAYS
    }
    // Tier 956: a new end moves the private use of the months between the old
    // and the new one; a new commute changes every month the car was used
    const today = businessTodayDate()
    const oldEnd = car.untilDate ?? today
    if ('commuteKm' in data || 'commuteDays' in data) {
      await assertPeriodOpen(this.prisma, companyId, monthEnds(car.fromDate, oldEnd), 'das Ändern eines Firmenwagens')
    }
    if ('untilDate' in data) {
      const newEnd = (data.untilDate as Date | null) ?? today
      const [a, b] = oldEnd < newEnd ? [oldEnd, newEnd] : [newEnd, oldEnd]
      await assertPeriodOpen(this.prisma, companyId, monthEnds(a, b), 'das Ändern des Endes eines Firmenwagens')
    }
    return this.prisma.companyCar.update({ where: { id }, data })
  }

  async remove(companyId: string, id: string) {
    const car = await this.prisma.companyCar.findFirst({ where: { id, companyId } })
    if (!car) throw new NotFoundException('Firmenwagen nicht gefunden')
    // Tier 956: its private use leaves every month it was in
    await assertPeriodOpen(this.prisma, companyId, monthEnds(car.fromDate, car.untilDate ?? businessTodayDate()), 'das Löschen eines Firmenwagens')
    await this.prisma.companyCar.delete({ where: { id } })
    return { ok: true }
  }

  /** The year's private use per month (for the settings card). */
  async yearSummary(companyId: string, year: number) {
    const r = await privateCarUse(this.prisma, companyId, new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year, 11, 31)))
    return { year, ...r, roundedListPrices: (await this.list(companyId)).map((c) => ({ id: c.id, rounded: roundedListPrice(c.listPrice) })) }
  }
}
