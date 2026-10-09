import { StrictNumber } from '../../common/strict-number'
import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Put, Query } from '@nestjs/common'
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator'
import { Require } from '../../auth/roles.decorator'
import { PrismaService } from '../../prisma/prisma.service'
import { isKapitalgesellschaft, resolveRechtsform } from '../company/rechtsform'
import { HOME_OFFICE_METHODS, homeOfficeAmount, MAX_TAGE } from './home-office'

/** Tier 504: PUT /home-office/:year */
export class SetHomeOfficeDto {
  @IsIn(HOME_OFFICE_METHODS as unknown as string[])
  method!: string

  /** Tagespauschale: days mainly worked at home (counted up to 210) */
  @IsOptional() @StrictNumber() @IsInt() @Min(0) @Max(366)
  days?: number

  /** Jahrespauschale: months the home office was the centre of the work */
  @IsOptional() @StrictNumber() @IsInt() @Min(1) @Max(12)
  months?: number
}

@Injectable()
export class HomeOfficeService {
  constructor(private prisma: PrismaService) {}

  async get(companyId: string, year: number) {
    const row = await this.prisma.homeOffice.findUnique({ where: { companyId_year: { companyId, year } } })
    // An object either way (an empty body for null is no JSON for the client).
    return row ? { ...row, amount: homeOfficeAmount(row), maxDays: MAX_TAGE } : { method: null, amount: 0, maxDays: MAX_TAGE }
  }

  async set(companyId: string, year: number, dto: SetHomeOfficeDto) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { name: true, legalName: true, rechtsform: true, settings: true },
    })
    if (!company) throw new NotFoundException('Firma nicht gefunden')
    if (isKapitalgesellschaft(resolveRechtsform(company).rechtsform)) {
      throw new BadRequestException(
        'Eine Kapitalgesellschaft hat keine Homeoffice-Pauschale — der Geschäftsführer macht sie als Werbungskosten geltend.',
      )
    }
    if (dto.method === 'tagespauschale' && dto.days == null) throw new BadRequestException('Anzahl der Homeoffice-Tage angeben.')
    const data = {
      method: dto.method,
      days: dto.method === 'tagespauschale' ? dto.days! : null,
      months: dto.method === 'jahrespauschale' ? dto.months ?? 12 : null,
    }
    const row = await this.prisma.homeOffice.upsert({
      where: { companyId_year: { companyId, year } },
      create: { companyId, year, ...data },
      update: data,
    })
    return { ...row, amount: homeOfficeAmount(row), maxDays: MAX_TAGE }
  }

  async remove(companyId: string, year: number) {
    const row = await this.prisma.homeOffice.findUnique({ where: { companyId_year: { companyId, year } } })
    if (!row) throw new NotFoundException('Kein Homeoffice für dieses Jahr erfasst')
    await this.prisma.homeOffice.delete({ where: { id: row.id } })
    return { ok: true }
  }
}

const yearOf = (s: string) => {
  const y = parseInt(s, 10)
  if (!y || y < 2023 || y > 2100) throw new BadRequestException('Jahr ab 2023 (Homeoffice-Pauschalen seit 2023)')
  return y
}

/** Tier 504 — the home office per year. */
@Controller('home-office')
export class HomeOfficeController {
  constructor(private homeOffice: HomeOfficeService) {}

  @Get(':year')
  @Require('company.read')
  get(@Query('companyId') companyId: string, @Param('year') year: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.homeOffice.get(companyId, yearOf(year))
  }

  @Put(':year')
  @Require('company.update')
  set(@Query('companyId') companyId: string, @Param('year') year: string, @Body() body: SetHomeOfficeDto) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.homeOffice.set(companyId, yearOf(year), body)
  }

  @Delete(':year')
  @Require('company.update')
  remove(@Query('companyId') companyId: string, @Param('year') year: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.homeOffice.remove(companyId, yearOf(year))
  }
}

@Module({ controllers: [HomeOfficeController], providers: [HomeOfficeService] })
export class HomeOfficeModule {}
