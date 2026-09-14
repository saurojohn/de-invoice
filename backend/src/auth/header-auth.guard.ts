import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { ALLOW_OTHER_COMPANY_ID_KEY, COMPANY_ID_PARAM_KEY, IS_PUBLIC_KEY } from './public.decorator';

/**
 * Auth guard — reads `x-user-id` and `x-company-id` from request headers
 * and attaches the corresponding user object to `req.user`. Requires
 * BOTH headers; mismatched/expired/inactive users are rejected.
 *
 * Tier 66 update: the access check is now via
 * `UserCompany` (many-to-many) instead of `User.companyId`.
 * A Berater (Steuerberater) has one row per Mandant;
 * the guard verifies x-company-id is in the user's
 * granted companies. The per-company role is read
 * from UserCompany.role and attached to `req.user`
 * (overrides User.role which is now the default).
 *
 * NOTE: this is a header-based shim, not JWT. Fine for first-party
 * dashboard use. For per-action permission checks, use
 * `@Require('action')` on the controller method.
 *
 * Tier 375: registered globally (app.module.ts APP_GUARD), so it runs for
 * every route; @Public() opts out. It still appears in many @UseGuards /
 * @Auth() decorators — the second run returns early instead of repeating
 * the two DB lookups. It also binds the request's `companyId` (path, query,
 * body) to the authenticated company: before, any registered user could
 * read another tenant's invoices by changing `?companyId=`.
 */
@Injectable()
export class HeaderAuthGuard implements CanActivate {
  constructor(
    private prisma: PrismaService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest();

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    if (req.headerAuthDone) {
      return true;
    }

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
    if (user.status !== 'active') {
      throw new UnauthorizedException('Benutzer ist nicht aktiv')
    }

    // Tier 66: verify the x-company-id is in the user's
    // granted companies (UserCompany). This is the
    // many-to-many check — replaces the old strict
    // 1:1 User.companyId == companyId check.
    const access = await this.prisma.userCompany.findUnique({
      where: {
        userId_companyId: { userId, companyId },
      },
      select: { role: true },
    })
    if (!access) {
      // Cross-tenant access is never allowed. The user
      // has no UserCompany row for this company — even
      // if they once had access, this is the
      // authoritative grant check.
      throw new UnauthorizedException('Kein Zugriff auf diese Firma')
    }

    // Attach the user with the per-company role. The
    // `@Require('xxx')` permission checks downstream
    // use req.user.role — which now reflects the
    // per-company role, not the global User.role.
    //
    // Tier 71: also read the `x-readonly` header.
    // When set to "1" / "true", the request is
    // tagged as read-only and every mutation
    // endpoint returns 403. The Steuerberater
    // (or anyone) flips this on via a UI toggle
    // to safely review a Mandant without risking
    // an accidental write. The flag is per-request
    // — there's no persistent server-side state.
    const readonlyHeader = String(
      req.headers['x-readonly'] || '',
    ).toLowerCase()
    const readonly = readonlyHeader === '1' || readonlyHeader === 'true'
    req.user = { ...user, role: access.role, readonly }

    if (!this.reflector.getAllAndOverride<boolean>(ALLOW_OTHER_COMPANY_ID_KEY, targets)) {
      const companyParam = this.reflector.getAllAndOverride<string>(COMPANY_ID_PARAM_KEY, targets)
      for (const [where, value] of [
        ['path', req.params?.companyId],
        ['path', companyParam ? req.params?.[companyParam] : undefined],
        ['query', req.query?.companyId],
        ['body', req.body && typeof req.body === 'object' ? req.body.companyId : undefined],
      ] as const) {
        if (value === undefined || value === null || value === '') continue
        // An array (?companyId=a&companyId=b) or a non-string body value can
        // never be the authenticated company.
        if (value !== companyId) {
          throw new ForbiddenException(`Kein Zugriff auf diese Firma (companyId im ${where === 'path' ? 'Pfad' : where === 'query' ? 'Query-String' : 'Body'})`)
        }
      }
    }

    req.headerAuthDone = true
    return true
  }
}
