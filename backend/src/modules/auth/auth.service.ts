import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private prisma: PrismaService) {}

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    // Block inactive users (deactivated by admin) from logging in
    if (user.status && user.status !== 'active') {
      throw new UnauthorizedException('Account deaktiviert. Bitte kontaktieren Sie den Administrator.');
    }

    return user;
  }

  async register(data: { email: string; password: string; companyName: string }) {
    const hash = await bcrypt.hash(data.password, 10);

    const company = await this.prisma.company.create({
      data: {
        name: data.companyName,
        address: { street: '', city: '', postalCode: '', country: 'DE' }
      },
    });

    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash: hash,
        companyId: company.id,
        role: 'admin',
      },
    });

    // Tier 66 multi-tenancy: the header-auth
    // guard's many-to-many grant check requires
    // a UserCompany row. Without this, the new
    // admin can't access their own company
    // (Kein Zugriff auf diese Firma). The role
    // mirrors the global User.role (admin)
    // because the new user is the founder of
    // the company — they get the highest
    // per-company grant automatically.
    await this.prisma.userCompany.create({
      data: {
        userId: user.id,
        companyId: company.id,
        role: 'admin',
      },
    });

    // SECURITY: never return passwordHash / passwordResetToken to the client.
    return {
      company: {
        id: company.id,
        name: company.name,
        address: company.address,
      },
      user: {
        id: user.id,
        email: user.email,
        companyId: user.companyId,
        role: user.role,
        status: user.status,
      },
    };
  }

  /**
   * Generate a password-reset token for the given email and return:
   *   { tokenPlain, user } | null
   *
   * Returns null when the email is not registered — callers must always
   * surface a generic message to avoid user enumeration.
   *
   * The tokenPlain (32-byte URL-safe random) is what we email the user.
   * Only its bcrypt-hashed form is persisted in the DB.
   */
  async createPasswordResetToken(email: string): Promise<{ tokenPlain: string; user: { id: string; email: string; companyId: string | null } } | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, companyId: true },
    });
    if (!user) return null;

    // 32 random bytes -> 64 hex chars; user clicks link with this raw token
    const tokenPlain = randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(tokenPlain, 10);
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: tokenHash,
        passwordResetExpires: expires,
      },
    });

    this.logger.log(`Password reset requested for user=${user.id} email=${user.email}`);
    return { tokenPlain, user };
  }

  /**
   * Verify a raw reset token (URL param) against the stored bcrypt hash.
   * Returns the user id when valid and not expired; null otherwise.
   *
   * Note: the lookup is O(N) by recent-reset window — for a small user
   * table this is fine. For a real production system at scale, store
   * the token in a separate keyed table (userId, tokenHash, expires).
   */
  async verifyPasswordResetToken(tokenPlain: string): Promise<string | null> {
    if (!tokenPlain || tokenPlain.length < 32) return null;
    // Pull candidates whose reset is still valid
    const candidates = await this.prisma.user.findMany({
      where: {
        passwordResetExpires: { gt: new Date() },
        passwordResetToken: { not: null },
      },
      select: { id: true, passwordResetToken: true },
    });
    for (const c of candidates) {
      // Constant-time compare (bcrypt.compare is constant-time)
      const ok = await bcrypt.compare(tokenPlain, c.passwordResetToken as string);
      if (ok) return c.id;
    }
    return null;
  }

  /**
   * Reset the password for a user identified by a valid raw token.
   * Throws BadRequest on expired/invalid token or weak password.
   */
  async resetPassword(tokenPlain: string, newPassword: string): Promise<{ ok: true; userId: string }> {
    if (newPassword.length < 8) {
      throw new BadRequestException('Passwort muss mindestens 8 Zeichen lang sein');
    }
    if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      throw new BadRequestException('Passwort muss Buchstaben und Zahlen enthalten');
    }

    const userId = await this.verifyPasswordResetToken(tokenPlain);
    if (!userId) {
      throw new BadRequestException('Token ungültig oder abgelaufen');
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: hash,
        // Invalidate any other active reset tokens for this user
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user) {
        await this.prisma.auditLog.create({
          data: {
            companyId: user.companyId ?? undefined,
            userId: user.id,
            action: 'password_reset_success',
            entityType: 'auth',
            entityId: user.id,
          },
        });
      }
    } catch { /* ignore */ }

    return { ok: true, userId };
  }
}
