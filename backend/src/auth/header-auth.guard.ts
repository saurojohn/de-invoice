import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Lightweight auth guard — reads `x-user-id` and `x-company-id` from
 * request headers (set by the frontend from localStorage) and attaches
 * the corresponding user object to `req.user`.
 *
 * This is a temporary shim until full JWT/session is implemented.
 * - Insecure for production behind untrusted networks
 * - Fine for single-tenant usage where users don't share companyIds
 *
 * For per-action permission checks, use UsersService.requireRole().
 */
@Injectable()
export class HeaderAuthGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    try {
      const userId = req.headers['x-user-id'] as string | undefined;
      const companyId = req.headers['x-company-id'] as string | undefined;
      if (!userId) return true;
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, companyId: true, role: true, status: true },
      });
      if (!user) return true;
      if (companyId && user.companyId && user.companyId !== companyId) return true;
      if (user.status !== 'active') return true;
      req.user = user;
      return true;
    } catch {
      return true;
    }
  }
}
