import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { assertBodyBoundToCaller } from './caller-bound-upload';
import { ALLOW_OTHER_COMPANY_ID_KEY, COMPANY_ID_PARAM_KEY, IS_PUBLIC_KEY } from './public.decorator';
import { UserSessionService } from './user-session.service';
import { getRequestContext } from '../prisma/request-context';
import { legacyHeaderAuthAllowed } from './auth-mode';

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
    private sessions: UserSessionService,
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

    // Tier 400: the session cookie (or Authorization: Bearer) is the credential.
    // `x-user-id` used to BE the credential — knowing a UUID was enough to be
    // that user (HANDOFF §9 item 10). It is still accepted while
    // ALLOW_HEADER_AUTH is on, which is how ~300 existing specs keep working;
    // production sets ALLOW_HEADER_AUTH=0 and only the cookie counts.
    const companyId = req.headers['x-company-id'] as string | undefined;
    let userId: string | undefined;

    const sessionToken = UserSessionService.tokenFromRequest(req);
    if (sessionToken) {
      const session = await this.sessions.resolve(sessionToken);
      if (!session) {
        throw new UnauthorizedException('Sitzung abgelaufen oder ungültig');
      }
      userId = session.userId;
      req.sessionId = session.sessionId;
    } else if (legacyHeaderAuthAllowed()) {
      userId = req.headers['x-user-id'] as string | undefined;
    }

    if (!userId || !companyId) {
      throw new UnauthorizedException(
        legacyHeaderAuthAllowed()
          ? 'Authentifizierung erforderlich (x-user-id und x-company-id fehlen)'
          : 'Authentifizierung erforderlich (keine gültige Sitzung)',
      )
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

    // Tier 400: the audit context (Tier 384) is started by a middleware that
    // runs before guards, so with a session cookie it has no user yet. Fill it
    // in here — the ALS store is a mutable object, so the audit extension sees
    // the authenticated user rather than whatever the client put in a header.
    const auditCtx = getRequestContext()
    if (auditCtx) {
      auditCtx.userId = user.id
      auditCtx.companyId = companyId
    }

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

    // Tier 383: actor ids in the body name the authenticated user. Several
    // routes took `createdById` / `closedById` / `uploadedById` from the client
    // and wrote it into GoBD records: company A's credit-adjust with another
    // tenant's user id as createdById answered 201 and stored that user as the
    // author (measured). The UI and the specs always send their own id.
    // Multipart bodies are parsed after the guards: see CallerBoundUpload.
    assertBodyBoundToCaller(req.body, companyId, userId, { checkCompany: false })

    req.headerAuthDone = true
    return true
  }
}
