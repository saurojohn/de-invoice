import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  Param,
  BadRequestException,
  ForbiddenException,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { HeaderAuthGuard } from '../../auth/header-auth.guard';

interface AuthedRequest extends Request {
  user?: { id: string; companyId: string; role: string };
}

@Controller('users')
@UseGuards(HeaderAuthGuard)
export class UsersController {
  constructor(private users: UsersService) {}

  /**
   * List all users in the caller's company (admin only).
   */
  @Get()
  async list(@Query('companyId') companyId: string, @Req() req: AuthedRequest) {
    if (!companyId) throw new BadRequestException('companyId is required');
    UsersService.requireRole(req.user?.role, 'users.read');
    return {
      users: await this.users.listCompanyUsers(companyId),
      pendingInvitations: await this.users.listPendingInvitations(companyId),
    };
  }

  /**
   * Tier 66: list every company (Mandant) the
   * currently-authenticated user has access to.
   *
   * Drives the "Mandant wechseln" dropdown in the
   * header. Returns one row per UserCompany grant
   * (i.e. one row per company the user can switch
   * into) with the per-company role + a flag
   * indicating whether the row is the user's
   * CURRENTLY-ACTIVE Mandant.
   *
   * The current Mandant is determined by the
   * x-company-id header (set by the dropdown's
   * POST /me/switch handler). The flag lets the
   * UI mark the active item with a checkmark.
   *
   * Auth: requires a valid user (any role) —
   * the dropdown is for ALL users, not just
   * admins, because every user with multi-
   * Mandant access needs the switcher.
   */
  @Get('me/companies')
  async myCompanies(@Req() req: AuthedRequest) {
    const userId = req.user?.id
    if (!userId) throw new BadRequestException('Unauthenticated')
    // Read the active company from the request —
    // the guard has already validated the user
    // has access to it, so we don't need to
    // verify again here.
    const activeCompanyId = (req as any)?.headers?.['x-company-id']
    const companies = await this.users.listAccessibleCompanies(
      userId,
      activeCompanyId,
    )
    return {
      activeCompanyId: activeCompanyId || null,
      companies,
    }
  }

  /**
   * Tier 66: switch the active Mandant.
   *
   * Validates the user has access to the requested
   * companyId (via UserCompany), then returns the
   * new active company metadata. The frontend
   * updates the x-company-id cookie + localStorage
   * and reloads — no other state is changed on
   * the server (the "active company" is purely a
   * client-side concept held in the x-company-id
   * header).
   *
   * Why server-side validation: a malicious user
   * could POST any companyId. We must verify the
   * grant before returning success. If the user
   * has no UserCompany row for the target, 403.
   */
  @Post('me/switch-company')
  async switchCompany(
    @Req() req: AuthedRequest,
    @Body() body: { companyId: string },
  ) {
    const userId = req.user?.id
    if (!userId) throw new BadRequestException('Unauthenticated')
    if (!body?.companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    const target = await this.users.switchActiveCompany(userId, body.companyId)
    if (!target) {
      // The user has no UserCompany row for this
      // companyId — refuse.
      // Tier 235 fix: use ForbiddenException (403) instead of
      // BadRequestException (400). The 4xx status was correct
      // but 403 is the semantically right code for an
      // authorisation failure (caller authenticated but not
      // permitted). The e2e test (161-tier231-users-crud.sh)
      // previously asserted 4xx-with-German-message; with this
      // fix it now asserts 403 specifically.
      throw new ForbiddenException('Kein Zugriff auf diese Firma')
    }
    return target
  }

  /**
   * Invite a new user. Sends an email with the invite link.
   * Rate-limited: 10 per hour per IP.
   */
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @Post('invitations')
  async invite(
    @Query('companyId') companyId: string,
    @Body() body: { email?: string; role?: string },
    @Req() req: AuthedRequest,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    UsersService.requireRole(req.user?.role, 'users.invite');
    if (!req.user?.id) throw new BadRequestException('Unauthenticated');
    if (!body.email || !body.role) {
      throw new BadRequestException('email und role sind erforderlich');
    }
    const inv = await this.users.createInvitation(companyId, req.user.id, body.email, body.role);

    // Build the invite link and email it (graceful: logs to console if SMTP not configured)
    try {
      const origin =
        (req as any)?.headers?.origin ||
        process.env.APP_ORIGIN ||
        `http://localhost:${process.env.PORT || 3000}`;
      const link = `${origin.replace(/\/$/, '')}/register?invite=${inv.tokenPlain}`;

      // Access private mailService via any-cast (kept internal to this module)
      const mailService = (this.users as any).mailService;
      if (mailService) {
        await mailService.send(companyId, {
          to: inv.email,
          subject: 'Einladung zu de-invoice',
          text:
            `Sie wurden eingeladen, dem Team "${inv.companyName ?? 'Ihr Unternehmen'}" auf de-invoice beizutreten.\n\n` +
            `Klicken Sie auf den folgenden Link, um die Einladung anzunehmen und ein Passwort festzulegen (gültig 7 Tage):\n` +
            `${link}\n\n` +
            `Falls Sie diese Einladung nicht erwartet haben, ignorieren Sie diese E-Mail.`,
          html: `
            <p>Sie wurden eingeladen, dem Team <strong>${inv.companyName ?? 'Ihr Unternehmen'}</strong> auf de-invoice beizutreten.</p>
            <p>Klicken Sie auf den folgenden Link, um die Einladung anzunehmen und ein Passwort festzulegen (gültig 7 Tage):</p>
            <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px;">Einladung annehmen</a></p>
            <p>Oder kopieren Sie diesen Link:<br><code>${link}</code></p>
          `,
        });
      }
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn(
          `[DEV-INVITE-LINK] company=${companyId} email=${inv.email} role=${inv.role} link=${link}`
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to email invitation to ${inv.email}: ${(err as Error).message}`);
    }

    return {
      id: inv.id,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt,
    };
  }

  /**
   * Resend a pending invitation (regenerates token).
   */
  @Post('invitations/:id/resend')
  async resend(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    UsersService.requireRole(req.user?.role, 'users.invite');
    return this.users.resendInvitation(companyId, id);
  }

  /**
   * Cancel a pending invitation.
   */
  @Delete('invitations/:id')
  async cancel(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    UsersService.requireRole(req.user?.role, 'users.invite');
    await this.users.cancelInvitation(companyId, id);
    return { ok: true };
  }

  /**
   * Change a user's role.
   */
  @Patch(':id/role')
  async changeRole(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: { role?: string },
    @Req() req: AuthedRequest,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    UsersService.requireRole(req.user?.role, 'users.changeRole');
    if (!body.role) throw new BadRequestException('role ist erforderlich');
    return this.users.changeRole(companyId, id, body.role);
  }

  /**
   * Activate or deactivate a user.
   */
  @Patch(':id/status')
  async setStatus(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: { status?: 'active' | 'inactive' },
    @Req() req: AuthedRequest,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    UsersService.requireRole(req.user?.role, 'users.deactivate');
    if (!body.status) throw new BadRequestException('status ist erforderlich');
    return this.users.setStatus(companyId, id, body.status);
  }
}

/**
 * Public endpoints (no auth) for invitation acceptance flow:
 *   GET  /api/v1/invitations/verify?token=...  →  { email, role, companyName }
 *   POST /api/v1/invitations/accept            →  { token, password } → creates user
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private users: UsersService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('verify')
  async verify(@Query('token') token: string) {
    if (!token) throw new BadRequestException('token ist erforderlich');
    const inv = await this.users.verifyInvitationToken(token);
    if (!inv) {
      return { valid: false, message: 'Einladung ungültig oder abgelaufen' };
    }
    return {
      valid: true,
      email: inv.email,
      role: inv.role,
      companyId: inv.companyId,
      companyName: inv.companyName,
      expiresAt: inv.expiresAt,
    };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('accept')
  async accept(@Body() body: { token?: string; password?: string }) {
    if (!body.token || !body.password) {
      throw new BadRequestException('token und password sind erforderlich');
    }
    const result = await this.users.acceptInvitation(body.token, body.password);
    return {
      ok: true,
      userId: result.user.id,
      email: result.user.email,
      role: result.user.role,
      companyId: result.companyId,
      companyName: result.companyName,
    };
  }
}
