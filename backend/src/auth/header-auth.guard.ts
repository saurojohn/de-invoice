import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Auth guard — reads `x-user-id` and `x-company-id` from request headers
 * and attaches the corresponding user object to `req.user`. Requires
 * BOTH headers; mismatched/expired/inactive users are rejected.
 *
 * NOTE: this is a header-based shim, not JWT. Fine for first-party
 * dashboard use. For per-action permission checks, use
 * `@Require('action')` on the controller method.
 */
@Injectable()
export class HeaderAuthGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest();

    const userId = req.headers['x-user-id'] as string | undefined;
    const companyId = req.headers['x-company-id'] as string | undefined;

    // Both headers are required. A request missing either is unauthorized.
    if (!userId || !companyId) {
      throw new UnauthorizedException('Authentifizierung erforderlich (x-user-id und x-company-id fehlen)')
    }

    let user
    try {
      user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, companyId: true, role: true, status: true },
      })
    } catch (e) {
      throw new UnauthorizedException('Authentifizierung fehlgeschlagen')
    }

    if (!user) {
      throw new UnauthorizedException('Ungültiger Benutzer')
    }
    if (user.companyId !== companyId) {
      // Cross-tenant access is never allowed.
      throw new UnauthorizedException('Ungültige Firma-Zuordnung')
    }
    if (user.status !== 'active') {
      throw new UnauthorizedException('Benutzer ist nicht aktiv')
    }

    req.user = user
    return true
  }
}
