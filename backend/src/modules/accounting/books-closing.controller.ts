import { BadRequestException, Body, Controller, Get, Put, Query, Req } from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { PrismaService } from '../../prisma/prisma.service'
import { AuditService } from '../audit/audit.service'
import { businessTodayIso } from '../../common/business-date'
import { booksClosedUntilOf } from '../reports/filed-period'

/**
 * Tier 609 — closing the books (Festschreibung).
 *
 * GET  /accounting/books-closing            → { closedUntil }
 * PUT  /accounting/books-closing            { closedUntil: 'YYYY-MM-DD' | null, reason? }
 *
 * Up to and including `closedUntil` nothing is written, changed or deleted
 * (reports/filed-period.ts). Setting a later day closes more; an earlier day
 * or null lifts the closing — allowed, on purpose, with a reason, and written
 * to the audit log either way. Both are the company admin's (`company.update`).
 */
@Auth()
@Controller('accounting/books-closing')
export class BooksClosingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Require('accounting.read')
  async get(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return { closedUntil: await booksClosedUntilOf(this.prisma, companyId) }
  }

  @Put()
  @Require('company.update')
  async set(
    @Query('companyId') companyId: string,
    @Body() body: { closedUntil?: unknown; reason?: unknown },
    @Req() req: any,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const raw = body?.closedUntil
    if (raw !== null && (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw + 'T00:00:00Z')) || new Date(raw + 'T00:00:00Z').toISOString().slice(0, 10) !== raw)) {
      throw new BadRequestException('closedUntil muss ein Datum (JJJJ-MM-TT) oder null sein.')
    }
    const next = raw as string | null
    if (next && next > businessTodayIso()) {
      throw new BadRequestException('Die Bücher lassen sich nicht über den heutigen Tag hinaus abschließen.')
    }
    const before = await booksClosedUntilOf(this.prisma, companyId)
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
    const lifting = !!before && (!next || next < before)
    if (lifting && reason.length < 5) {
      throw new BadRequestException('Bitte begründen Sie, warum der Abschluss aufgehoben wird (reason).')
    }
    if (before === next) return { closedUntil: before }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { booksClosedUntil: next ? new Date(next + 'T00:00:00Z') : null },
    })
    await this.audit.writeActivity({
      companyId,
      userId: req?.user?.id ?? null,
      action: lifting ? 'books.reopened' : 'books.closed',
      entityType: 'Company',
      entityId: companyId,
      oldData: { booksClosedUntil: before },
      metadata: { booksClosedUntil: next, ...(reason ? { reason } : {}) },
    })
    return { closedUntil: next }
  }
}
