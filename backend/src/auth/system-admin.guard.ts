import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UseGuards, applyDecorators } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { HeaderAuthGuard } from './header-auth.guard'
import { RolesGuard } from './roles.guard'

/**
 * Tier 548 — the installation's operator, as opposed to a company's admin.
 *
 * Registration is public, and whoever registers is the admin of the company
 * they created. The routes that act on the whole installation asked for a
 * company-level action only (`admin.read`, `company.update`). Measured as
 * the admin of a company registered a minute before: GET /admin/backups
 * (200 — every backup with its path on the server), POST /admin/backups/run,
 * DELETE /admin/backups/:id, POST /admin/backups/restore-drill, GET
 * /admin/cron-health and POST /admin/cron-health/:name/run (any scheduler,
 * for all companies), the storage configuration, the operator's notification
 * settings, POST /fints/auto-run (the bank sync of every company).
 *
 * Who the operator is:
 *   - `SYSTEM_ADMIN_EMAILS` (comma-separated) when set: exactly those users;
 *   - otherwise the admins of the oldest company in the database — the one
 *     the installation was set up with.
 */
@Injectable()
export class SystemAdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest()
    const user = req.user as { email?: string; companyId?: string; role?: string } | undefined
    const refuse = () => new ForbiddenException('Diese Funktion ist dem Betreiber der Installation vorbehalten.')
    if (!user) throw refuse()

    const listed = String(process.env.SYSTEM_ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
    if (listed.length > 0) {
      if (listed.includes(String(user.email || '').toLowerCase())) return true
      throw refuse()
    }
    const first = await this.prisma.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
    if (first && user.companyId === first.id && user.role === 'admin') return true
    throw refuse()
  }
}

/** Class decorator for a controller that is the operator's as a whole. */
export const SystemAuth = () => applyDecorators(UseGuards(HeaderAuthGuard, RolesGuard, SystemAdminGuard))
