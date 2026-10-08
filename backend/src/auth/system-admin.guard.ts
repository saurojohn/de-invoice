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
 * Who the operator is: an admin of the oldest company in the database — the
 * one the installation was set up with — acting in that company. With
 * `SYSTEM_ADMIN_EMAILS` (comma-separated) set, only those of them.
 */
/**
 * Is this the operator of the installation? (Tier 589: as a function, for a
 * route that is open to everyone but shows the operator more.)
 */
export async function isSystemAdmin(
  prisma: PrismaService,
  user: { email?: string; companyId?: string; role?: string } | undefined,
): Promise<boolean> {
  if (!user) return false
  const first = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (!first || user.companyId !== first.id || user.role !== 'admin') return false
  const listed = String(process.env.SYSTEM_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return listed.length === 0 || listed.includes(String(user.email || '').toLowerCase())
}

@Injectable()
export class SystemAdminGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest()
    const user = req.user as { email?: string; companyId?: string; role?: string } | undefined
    const refuse = () => new ForbiddenException('Diese Funktion ist dem Betreiber der Installation vorbehalten.')
    if (!user) throw refuse()

    // Tier 565: the operator's company first, in every case. The e-mail list
    // used to be sufficient on its own — but registration is public and
    // nobody verifies an address: whoever registered a new company with a
    // listed address that had no account yet was the operator. A new
    // registration creates a new company, never joins the oldest one, so the
    // list can now only narrow the circle, not open it.
    if (await isSystemAdmin(this.prisma, user)) return true
    throw refuse()
  }
}

/** Class decorator for a controller that is the operator's as a whole. */
export const SystemAuth = () => applyDecorators(UseGuards(HeaderAuthGuard, RolesGuard, SystemAdminGuard))
