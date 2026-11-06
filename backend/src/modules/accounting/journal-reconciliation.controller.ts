import { BadRequestException, Controller, Get, Query } from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { PrismaService } from '../../prisma/prisma.service'
import { businessToday } from '../../common/business-date'
import { journalReconciliation } from './journal-reconciliation'

/**
 * Tier 812 — GET /accounting/abstimmung?year=: the vouchers of a year that
 * are in the journal and the DATEV export and in no report
 * (journal-reconciliation.ts).
 */
@Auth()
@Controller('accounting/abstimmung')
export class JournalReconciliationController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Require('accounting.read')
  async get(@Query('companyId') companyId: string, @Query('year') yearRaw?: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw === undefined || yearRaw === '' ? businessToday().y : Number(yearRaw)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new BadRequestException('year ist ungültig')
    return journalReconciliation(this.prisma, companyId, year)
  }
}
