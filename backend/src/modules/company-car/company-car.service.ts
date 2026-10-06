import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { isKapitalgesellschaft, resolveRechtsform } from '../company/rechtsform'
import { CreateCompanyCarDto, EndCompanyCarDto } from './company-car.dto'
import { DEFAULT_COMMUTE_DAYS, privateCarUse, roundedListPrice } from './private-use'

/** Tier 502 — company cars used privately (private-use.ts). */
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
    return this.prisma.companyCar.update({ where: { id }, data })
  }

  async remove(companyId: string, id: string) {
    const car = await this.prisma.companyCar.findFirst({ where: { id, companyId } })
    if (!car) throw new NotFoundException('Firmenwagen nicht gefunden')
    await this.prisma.companyCar.delete({ where: { id } })
    return { ok: true }
  }

  /** The year's private use per month (for the settings card). */
  async yearSummary(companyId: string, year: number) {
    const r = await privateCarUse(this.prisma, companyId, new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year, 11, 31)))
    return { year, ...r, roundedListPrices: (await this.list(companyId)).map((c) => ({ id: c.id, rounded: roundedListPrice(c.listPrice) })) }
  }
}
