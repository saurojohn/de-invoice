import { Controller, Post, Body, HttpCode, HttpStatus, BadRequestException, Logger, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import * as bcrypt from 'bcrypt';

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
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: any) {
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
      try {
        await this.prisma.auditLog.create({
          data: {
            companyId: user.companyId || 'unknown',
            userId: user.id,
            action: 'login_failed_inactive',
            entityType: 'auth',
            entityId: user.id,
            notes: `IP=${ip}`,
          },
        });
      } catch { /* ignore */ }
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
      try {
        await this.prisma.auditLog.create({
          data: {
            companyId: user?.companyId || 'unknown',
            userId: user?.id || 'unknown',
            action: 'login_failed',
            entityType: 'auth',
            entityId: dto.email,
            notes: `IP=${ip} count=${a.count}`,
          },
        });
      } catch { /* ignore audit log errors */ }
      throw new BadRequestException('Invalid email or password');
    }

    this.attempts.delete(ip);
    try {
      await this.prisma.auditLog.create({
        data: {
          companyId: user.companyId,
          userId: user.id,
          action: 'login_success',
          entityType: 'auth',
          entityId: user.id,
          notes: `IP=${ip}`,
        },
      });
    } catch { /* ignore */ }
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
    return {
      id: user.id,
      email: user.email,
      companyId: user.companyId,
      role: user.role,
      status: user.status,
      profile: user.profile,
      preferences: user.preferences,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  }

  /**
   * Register: also rate-limited. Validates password strength server-side.
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(@Body() dto: RegisterDto) {
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
    return this.authService.register(dto);
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

      try {
        await this.prisma.auditLog.create({
          data: {
            companyId: result.user.companyId ?? undefined,
            userId: result.user.id,
            action: 'password_reset_requested',
            entityType: 'auth',
            entityId: result.user.id,
            notes: `IP=${req?.ip || 'unknown'}`,
          },
        });
      } catch { /* ignore */ }
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
