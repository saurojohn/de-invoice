import { Controller, Post, Body, Get, HttpCode, HttpStatus, BadRequestException, Logger, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { HeaderAuthGuard } from '../../auth/header-auth.guard';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import * as bcrypt from 'bcrypt';
import { Public } from '../../auth/public.decorator';
import { SESSION_TTL_DAYS, UserSessionService } from '../../auth/user-session.service';
import { Response } from 'express';

interface LoginAttempt {
  count: number;
  firstAt: number;
  lockedUntil: number;
  lastEmail: string;
}

const FAILED_LOGIN_WINDOW_MS = 15 * 60_000; // 15 min
const FAILED_LOGIN_MAX = 5;                   // 5 fails → lock
const FAILED_LOGIN_LOCK_MS = 15 * 60_000;      // 15 min lockout

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private attempts = new Map<string, LoginAttempt>(); // key: client IP

  constructor(
    private authService: AuthService,
    private prisma: PrismaService,
    private mailService: MailService,
    // Tier 368: signs the auth audit rows so they join the hash chain.
    private audit: AuditService,
    // Tier 400: mints the session the cookie carries.
    private sessions: UserSessionService,
  ) {}

  private cleanup() {
    const now = Date.now();
    for (const [ip, a] of this.attempts.entries()) {
      if (a.lockedUntil < now && now - a.firstAt > FAILED_LOGIN_WINDOW_MS) {
        this.attempts.delete(ip);
      }
    }
  }

  private getClientIp(req: any): string {
    return (
      req?.headers?.['x-forwarded-for']?.toString().split(',')[0].trim() ||
      req?.headers?.['x-real-ip'] ||
      req?.ip ||
      req?.socket?.remoteAddress ||
      'unknown'
    );
  }

  /**
   * Login: tight rate limit (5/min) + per-IP failed-attempt lockout.
   * Returns a GENERIC error message regardless of whether the email exists —
   * this prevents user enumeration and timing attacks.
   *
   * Tier 13: removed the AUTH_RATE_LIMIT_DISABLED
   * env-var bypass that Tier 12 used for
   * Playwright. Tests that need to call login
   * multiple times within a 60-second window
   * (e.g. e2e/24-2fa-totp.sh) sleep 13s between
   * calls to space them under the 5/min limit.
   * The env-var bypass was a real production
   * risk — anyone who started the backend with
   * AUTH_RATE_LIMIT_DISABLED=1 by accident
   * would have had login rate-limiting disabled.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.cleanup();
    const ip = this.getClientIp(req);
    const now = Date.now();

    const existing = this.attempts.get(ip);
    if (existing && existing.lockedUntil > now) {
      const remaining = Math.ceil((existing.lockedUntil - now) / 1000);
      this.logger.warn(`Login locked for IP ${ip} (${remaining}s remaining)`);
      throw new BadRequestException(
        `Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuchen Sie es in ${remaining} Sekunden erneut.`,
      );
    }

    // Constant-time check: always run bcrypt.compare even if user doesn't exist.
    // Prevents attackers from distinguishing "user not found" vs "wrong password" via response time.
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const DUMMY_HASH = '$2b$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTU';
    const hashToCheck = user?.passwordHash || DUMMY_HASH;
    const valid = await bcrypt.compare(dto.password, hashToCheck);

    // Inactive users (deactivated by admin) must not be able to log in.
    // We return the SAME generic error as for invalid credentials to avoid
    // leaking account status to attackers.
    if (user && user.status && user.status !== 'active') {
      this.logger.warn(`Login blocked: user ${user.id} (${user.email}) is inactive`);
      // Tier 368: signed via AuditService so this row joins the hash chain.
      // `|| 'unknown'` went into companyId, which is a FK to Company — for a
      // user without a company the insert violated it and the empty catch
      // swallowed the error. null is allowed by the column and persists.
      await this.audit.writeActivity({
        companyId: user.companyId || null,
        userId: user.id,
        action: 'login_failed_inactive',
        entityType: 'auth',
        entityId: user.id,
        ipAddress: ip,
        userAgent: req?.headers['user-agent'] || null,
      });
      throw new BadRequestException('Invalid email or password');
    }

    if (!user || !valid) {
      const a = this.attempts.get(ip) || { count: 0, firstAt: now, lockedUntil: 0, lastEmail: dto.email };
      a.count += 1;
      a.lastEmail = dto.email;
      if (a.count >= FAILED_LOGIN_MAX) {
        a.lockedUntil = now + FAILED_LOGIN_LOCK_MS;
        this.logger.warn(`IP ${ip} locked out after ${a.count} failed attempts (last email: ${a.lastEmail})`);
      }
      this.attempts.set(ip, a);
      // Tier 368: this row was silently lost for the failure that matters most.
      // When the e-mail does not exist, `user` is null, so companyId AND userId
      // were both the literal 'unknown' — both are FKs (to Company and User), so
      // every insert violated them and the empty catch discarded the error
      // without even a log line. Measured on a throwaway stack: a login attempt
      // with an unknown e-mail produced HTTP 400 and zero AuditLog rows, while a
      // real user with a wrong password (real ids) wrote its row fine. User
      // enumeration and credential stuffing were the un-audited cases.
      await this.audit.writeActivity({
        companyId: user?.companyId ?? null,
        userId: user?.id ?? null,
        action: 'login_failed',
        entityType: 'auth',
        entityId: dto.email,
        ipAddress: ip,
        userAgent: req?.headers['user-agent'] || null,
      });
      throw new BadRequestException('Invalid email or password');
    }

    this.attempts.delete(ip);
    // Tier 368: signed via AuditService (was an unsigned direct insert).
    await this.audit.writeActivity({
      companyId: user.companyId,
      userId: user.id,
      action: 'login_success',
      entityType: 'auth',
      entityId: user.id,
      ipAddress: ip,
      userAgent: req?.headers['user-agent'] || null,
    });
    // 2FA gate: if the user has TOTP enabled, the password
    // is correct but we don't issue the session yet —
    // return a 200 with twoFactorRequired:true so the
    // frontend can prompt for the 6-digit code. We use 200
    // (not 401) because the password WAS correct; the
    // response shape is the same so the frontend just
    // branches on twoFactorRequired.
    if (user.twoFactorEnabled && user.twoFactorConfirmedAt) {
      return {
        twoFactorRequired: true,
        email: user.email,
      } as any
    }
    // SECURITY: never leak passwordHash / passwordResetToken /
    // passwordResetExpires to the client. The login route is
    // public; even authenticated users should not see their own
    // bcrypt hash in the response. We only return what the
    // frontend needs to populate x-user-id / x-company-id.
    // Tier 400: mint the session and set the httpOnly cookie. `sessionToken`
    // is also returned so non-browser clients (the e2e suites, scripts) can send
    // `Authorization: Bearer` instead of carrying a cookie jar.
    const session = await this.sessions.issue(res, user.id, req, ip)
    return {
      id: user.id,
      email: user.email,
      companyId: user.companyId,
      role: user.role,
      status: user.status,
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
      profile: user.profile,
      preferences: user.preferences,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  }

  /**
   * Tier 175: GET /api/v1/auth/me
   *
   * Phase 3 Berater-Walkthrough finding: there was no
   * endpoint to ask the server "who am I + which companies
   * am I allowed to access?". The frontend kept
   * `x-user-id` + `x-company-id` in localStorage from a
   * prior login and used them blindly, so the client could
   * theoretically swap `x-company-id` to a company the
   * user had been granted in a previous session.
   *
   * The HeaderAuthGuard already verifies
   * `UserCompany` membership (line 58-70 in
   * header-auth.guard.ts) — a user without a row for
   * the claimed `x-company-id` gets 401. So the
   * attack surface is narrow: the client could only
   * pick a company the user already has a UserCompany
   * row for. Still, this endpoint is the canonical
   * "what does the server think I am" check the
   * frontend should call on every page load to:
   *   1. Re-validate the session (don't trust stale
   *      localStorage if the user was deactivated).
   *   2. Populate the Mandant switcher with the
   *      full list of granted companies.
   *   3. Show the user their global role vs
   *      per-company role (Berater may be 'admin'
   *      globally but 'berater' on a Mandant).
   *
   * Returns the same shape as /auth/login plus a
   * `companies` array of granted Mandanten.
   */
  @Get('me')
  @UseGuards(HeaderAuthGuard)
  async me(@Req() req: any) {
    // HeaderAuthGuard has already verified the user is
    // active AND that the x-company-id is in their granted
    // companies. We just re-read the live state from the
    // DB so the client gets a fresh snapshot.
    const userId = req.user.id;
    const companyId = req.user.companyId;

    const [user, grants] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          companyId: true,
          role: true,
          status: true,
          profile: true,
          preferences: true,
          createdAt: true,
          lastLogin: true,
        },
      }),
      // UserCompany grant list — used to populate the
      // Mandant switcher in the UI. We return the
      // companyId + role for each grant so the
      // switcher can show "SH Leder GmbH (admin)"
      // vs "Müller GmbH (berater)".
      this.prisma.userCompany.findMany({
        where: { userId },
        select: {
          role: true,
          company: {
            select: {
              id: true,
              name: true,
              legalName: true,
            },
          },
        },
        orderBy: { company: { name: 'asc' } },
      }),
    ]);

    if (!user) {
      // HeaderAuthGuard should have caught this. Defensive.
      throw new BadRequestException('User nicht gefunden');
    }

    // Find the per-company role for the *currently active*
    // company (HeaderAuthGuard already verified membership
    // — this is for display only).
    const activeGrant = grants.find((g) => g.company.id === companyId);

    return {
      ...user,
      // Override the global User.role with the
      // per-company role so the UI can branch on it
      // (e.g. a global "admin" Berater is "berater"
      // on each Mandant). This is the same value
      // HeaderAuthGuard already attached to req.user.role.
      role: activeGrant?.role ?? user.role,
      // Per-company grants. Empty array for users with
      // a single Mandant (the common case).
      companies: grants.map((g) => ({
        id: g.company.id,
        name: g.company.name,
        legalName: g.company.legalName,
        role: g.role,
      })),
    };
  }

  /**
   * Register: also rate-limited. Validates password strength server-side.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (dto.password.length < 8) {
      throw new BadRequestException('Passwort muss mindestens 8 Zeichen lang sein');
    }
    if (!/[A-Za-z]/.test(dto.password)) {
      throw new BadRequestException('Passwort muss mindestens einen Buchstaben enthalten');
    }
    if (!/[0-9]/.test(dto.password)) {
      throw new BadRequestException('Passwort muss mindestens eine Zahl enthalten');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dto.email)) {
      throw new BadRequestException('Ungültige E-Mail-Adresse');
    }
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      // Generic message — don't confirm the email exists
      throw new BadRequestException('Registrierung fehlgeschlagen. Bitte überprüfen Sie Ihre Angaben.');
    }
    const created = await this.authService.register(dto);
    // Tier 401: registration auto-logs the user in (the page writes the ids and
    // redirects to /dashboard), so it has to mint a session like /auth/login.
    const session = await this.sessions.issue(res, created.user.id, req);
    return {
      ...created,
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
    };
  }

  /**
   * Forgot password — issue a reset token and email a link to the user.
   *
   * Security:
   *  - Rate-limited (3 / hour per IP) to prevent abuse / token spam.
   *  - Always returns 200 with a generic message — does not reveal whether
   *    the email is registered (avoids user enumeration).
   *  - Token is 32 bytes (256 bits) of cryptographic randomness, hashed
   *    with bcrypt in the DB. The raw token only lives in the email.
   *  - Expires 1 hour after issue.
   *  - In dev (no SMTP configured), the link is logged to backend stdout
   *    so a developer can click it without setting up an SMTP server.
   */
  /**
   * Tier 400 — end the session behind the cookie (or Bearer token) and clear it.
   * Public: a request with an expired or already-revoked session must still be
   * able to log out rather than get a 401 it cannot clear.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: any, @Res({ passthrough: true }) res: Response) {
    const token = UserSessionService.tokenFromRequest(req)
    if (token) await this.sessions.revoke(token)
    res.setHeader('Set-Cookie', UserSessionService.clearedCookie())
    return { ok: true }
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() body: { email?: string },
    @Req() req: any,
  ) {
    const email = (body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      // Still 200 — generic. But we can short-circuit obvious junk.
      return { message: 'Falls ein Konto mit dieser E-Mail-Adresse existiert, wurde ein Link zum Zurücksetzen des Passworts versendet.' };
    }

    const result = await this.authService.createPasswordResetToken(email);

    if (result) {
      const origin =
        (req?.headers?.origin as string) ||
        process.env.APP_ORIGIN ||
        `http://localhost:${process.env.PORT || 3000}`;
      const link = `${origin.replace(/\/$/, '')}/reset-password?token=${result.tokenPlain}`;

      try {
        await this.mailService.send(result.user.companyId ?? 'system', {
          to: result.user.email,
          subject: 'Passwort zurücksetzen — de-invoice',
          text:
            `Sie haben eine Anfrage zum Zurücksetzen Ihres Passworts gestellt.\n\n` +
            `Klicken Sie auf den folgenden Link, um ein neues Passwort zu vergeben (gültig 1 Stunde):\n` +
            `${link}\n\n` +
            `Falls Sie diese Anfrage nicht gestellt haben, ignorieren Sie diese E-Mail. Ihr Passwort bleibt unverändert.`,
          html: `
            <p>Hallo,</p>
            <p>Sie haben eine Anfrage zum Zurücksetzen Ihres Passworts gestellt.</p>
            <p>Klicken Sie auf den folgenden Link, um ein neues Passwort zu vergeben (gültig 1 Stunde):</p>
            <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px;">Passwort zurücksetzen</a></p>
            <p>Oder kopieren Sie diesen Link in Ihren Browser:<br><code>${link}</code></p>
            <p style="color:#6b7280;font-size:12px;margin-top:24px;">Falls Sie diese Anfrage nicht gestellt haben, ignorieren Sie diese E-Mail. Ihr Passwort bleibt unverändert.</p>
          `,
        });
        this.logger.log(`Password reset email sent to ${result.user.email} (link logged in dev if SMTP not configured)`);
        if (process.env.NODE_ENV !== 'production') {
          this.logger.warn(`[DEV-RESET-LINK] ${link}`);
        }
      } catch (err) {
        this.logger.error(`Failed to send password reset email to ${result.user.email}: ${(err as Error).message}`);
      }

      // Tier 368: signed via AuditService (was an unsigned direct insert).
      await this.audit.writeActivity({
        companyId: result.user.companyId ?? null,
        userId: result.user.id,
        action: 'password_reset_requested',
        entityType: 'auth',
        entityId: result.user.id,
        ipAddress: req?.ip || null,
        userAgent: req?.headers['user-agent'] || null,
      });
    }

    // Always the same response (no enumeration)
    return {
      message:
        'Falls ein Konto mit dieser E-Mail-Adresse existiert, wurde ein Link zum Zurücksetzen des Passworts versendet.',
    };
  }

  /**
   * Reset password — accept a token (from email link) and a new password.
   * Verifies the token, updates the bcrypt hash, and invalidates the token.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() body: { token?: string; password?: string },
  ) {
    const token = (body?.token || '').trim();
    const password = body?.password || '';
    if (!token || !password) {
      throw new BadRequestException('Token und Passwort sind erforderlich');
    }
    await this.authService.resetPassword(token, password);
    return { ok: true, message: 'Passwort wurde aktualisiert. Sie können sich jetzt anmelden.' };
  }
}
