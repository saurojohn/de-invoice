/**
 * Tier 823 — the companies on the installation, for its operator.
 *
 *   GET /api/v1/admin/companies?q=&skip=&take=
 *
 * Since the registration can be closed and companies invited (Tiers 820 /
 * 821), the operator had no way to see what came of it: which companies
 * exist, who administers them, whether anybody uses them. One row per
 * company, newest first: its name, when it was made, whether it is closed
 * (Tier 737), its members and the addresses of its admins, its number of
 * invoices, the last sign-in of any member, and how it came — the operator's
 * own, an invitation (to which address) or the public registration.
 *
 * Nothing of a company's books beyond the count of its invoices: the
 * operator hosts the companies, the figures are theirs.
 */
import { BadRequestException, Controller, Get, Query } from '@nestjs/common'
import { SystemAuth } from '../../auth/system-admin.guard'
import { Require } from '../../auth/roles.decorator'
import { PrismaService } from '../../prisma/prisma.service'
import { listCompanyInvites } from '../auth/registration'

const MAX_TAKE = 200

@SystemAuth()
@Controller('admin/companies')
export class AdminCompaniesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Require('admin.read')
  async list(@Query('q') q?: string, @Query('skip') skipRaw?: string, @Query('take') takeRaw?: string) {
    const skip = skipRaw === undefined || skipRaw === '' ? 0 : Number(skipRaw)
    const take = takeRaw === undefined || takeRaw === '' ? 50 : Number(takeRaw)
    if (!Number.isInteger(skip) || skip < 0) throw new BadRequestException('skip muss eine ganze Zahl ≥ 0 sein.')
    if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE) throw new BadRequestException(`take muss zwischen 1 und ${MAX_TAKE} liegen.`)
    const term = String(q || '').trim().slice(0, 100)

    // the operator's company: the oldest (auth/system-admin.guard.ts)
    const first = await this.prisma.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
    const where = term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' as const } },
            { userCompanies: { some: { user: { email: { contains: term, mode: 'insensitive' as const } } } } },
          ],
        }
      : {}

    const [total, all, open, users, rows] = await Promise.all([
      this.prisma.company.count({ where }),
      this.prisma.company.count(),
      this.prisma.company.count({ where: { closedAt: null } }),
      this.prisma.user.count(),
      this.prisma.company.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
        select: {
          id: true,
          name: true,
          createdAt: true,
          closedAt: true,
          userCompanies: { select: { role: true, user: { select: { email: true, lastLogin: true } } } },
        },
      }),
    ])

    const ids = rows.map((r) => r.id)
    const counts = ids.length
      ? await this.prisma.invoice.groupBy({ by: ['companyId'], where: { companyId: { in: ids } }, _count: { _all: true } })
      : []
    const invoicesOf = new Map(counts.map((c) => [c.companyId, c._count._all]))
    const invitedAs = new Map<string, string>()
    if (first) {
      for (const i of await listCompanyInvites(this.prisma, first.id)) {
        if (i.companyId) invitedAs.set(i.companyId, i.email)
      }
    }

    return {
      total,
      totals: { companies: all, open, users },
      companies: rows.map((r) => {
        const logins = r.userCompanies.map((m) => m.user.lastLogin).filter((d): d is Date => !!d)
        return {
          id: r.id,
          name: r.name,
          createdAt: r.createdAt,
          closedAt: r.closedAt,
          origin: r.id === first?.id ? 'operator' : invitedAs.has(r.id) ? 'invite' : 'registration',
          invitedEmail: invitedAs.get(r.id) ?? null,
          members: r.userCompanies.length,
          admins: r.userCompanies.filter((m) => m.role === 'admin').map((m) => m.user.email).sort(),
          invoices: invoicesOf.get(r.id) ?? 0,
          lastLogin: logins.length ? new Date(Math.max(...logins.map((d) => d.getTime()))) : null,
        }
      }),
    }
  }
}
