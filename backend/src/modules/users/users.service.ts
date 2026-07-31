import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';

export const ROLES = {
  ADMIN: 'admin',
  ACCOUNTANT: 'accountant',
  VIEWER: 'viewer',
  // Tier 71: Berater (Steuerberater) — same
  // permissions as ACCOUNTANT but the UI shows a
  // "Read-Only Modus" banner and a one-click
  // toggle. The role is preserved in audit
  // trails so the Steuerberater's actions are
  // traceable as such. Permission matrix
  // doesn't differ from ACCOUNTANT — the
  // read-only behaviour is a UI / x-readonly
  // header concern, not a permission level.
  BERATER: 'berater',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

const VALID_ROLES = new Set<string>([ROLES.ADMIN, ROLES.ACCOUNTANT, ROLES.VIEWER, ROLES.BERATER]);

/**
 * Permission matrix — keep this in sync with the frontend.
 * Keys are action codes; values are the lowest role that can perform the action.
 *   - admin     : everything
 *   - accountant: full CRUD on business data, can NOT manage users / company settings
 *   - viewer    : read-only
 */
const PERMISSIONS: Record<string, Role> = {
  // user management
  'users.read': ROLES.ADMIN,
  'users.invite': ROLES.ADMIN,
  'users.changeRole': ROLES.ADMIN,
  'users.deactivate': ROLES.ADMIN,
  // company settings
  'company.read': ROLES.VIEWER,
  'company.update': ROLES.ADMIN,
  // business data
  'invoice.read': ROLES.VIEWER,
  'invoice.create': ROLES.ACCOUNTANT,
  'invoice.update': ROLES.ACCOUNTANT,
  'invoice.delete': ROLES.ACCOUNTANT,
  'invoice.send': ROLES.ACCOUNTANT,
  // Tier 67: audit-trail read access. Accountants
  // (incl. Steuerberater) need to see who changed
  // what for GoBD compliance; pure viewers don't.
  'audit.read': ROLES.ACCOUNTANT,
  // Tier 51/53: the InstallmentPlan module + the
  // credit-note endpoint use 'invoice.write' as a
  // shortcut for "create/update/delete on an
  // invoice-related resource". Maps to the same
  // ACCOUNTANT role as invoice.create.
  'invoice.write': ROLES.ACCOUNTANT,
  'customer.read': ROLES.VIEWER,
  'customer.create': ROLES.ACCOUNTANT,
  'customer.update': ROLES.ACCOUNTANT,
  'customer.delete': ROLES.ACCOUNTANT,
  'product.read': ROLES.VIEWER,
  'product.create': ROLES.ACCOUNTANT,
  'product.update': ROLES.ACCOUNTANT,
  'product.delete': ROLES.ACCOUNTANT,
  'accounting.read': ROLES.VIEWER,
  'accounting.create': ROLES.ACCOUNTANT,
  'accounting.update': ROLES.ACCOUNTANT,
  'accounting.delete': ROLES.ADMIN,
  'reports.read': ROLES.VIEWER,
  'reports.write': ROLES.ACCOUNTANT,
  'ustva.read': ROLES.ACCOUNTANT,
  'ustva.submit': ROLES.ADMIN,
  // Tier 79: Berater Document Exchange.
  //   - read: everyone with access (Berater +
  //           Mandant) can see the queue
  //   - create: ACCOUNTANT rank; the service
  //             then checks the actual role is
  //             exactly 'berater' (the @Require
  //             decorator can't express "only
  //             this exact role", so we do it
  //             in the service). With the role
  //             rank mapping (berater → accountant
  //             for permission checks), the
  //             Berater passes @Require AND the
  //             service-level 'berater'-only check.
  //   - acknowledge/dismiss: ACCOUNTANT rank;
  //             the service then checks the role
  //             is NOT 'berater' (only the Mandant
  //             can move the queue).
  'berater.note.read': ROLES.VIEWER,
  'berater.note.create': ROLES.ACCOUNTANT,
  'berater.note.acknowledge': ROLES.ACCOUNTANT,
  'berater.note.dismiss': ROLES.ACCOUNTANT,
  // Tier 108: SEPA pain.001 batch payments.
  //   - expense.read: open the list of unpaid
  //                   payables and browse past
  //                   batches (Berater + Mandant).
  //   - expense.write: create a new batch (marks
  //                    the selected expenses as
  //                    paid, generates pain.001).
  //   - payment.read / payment.write: reserved for
  //     future payment-reconciliation endpoints
  //     (e.g. matching incoming bank statements
  //     against planned batches). Not used yet —
  //     added here so the matrix stays in sync
  //     with the planned v2 surface.
  'expense.read': ROLES.VIEWER,
  'expense.write': ROLES.ACCOUNTANT,
  'payment.read': ROLES.VIEWER,
  'payment.write': ROLES.ACCOUNTANT,
  // Tier 119: system health (cron status).
  // The health dashboard is a debugging tool for
  // the Mandant + Berater — same rank as reports
  // (view-only) since reading the schedule doesn't
  // mutate state. `admin.read` (the actual permission
  // code on the controller) is mapped to
  // ACCOUNTANT so the Berater + the Mandant can both
  // see "why didn't the webhook-retry run?".
  'admin.read': ROLES.ACCOUNTANT,
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
  ) {}

  /**
   * Check if a role can perform an action. Higher-ranked roles inherit
   * everything lower roles can do.
   */
  static can(role: string | null | undefined, action: keyof typeof PERMISSIONS): boolean {
    if (!role) return false;
    const required = PERMISSIONS[action];
    if (!required) return false;
    // Tier 71: 'berater' is treated as 'accountant'
    // for the permission rank. The role distinction
    // is preserved in audit trails + the UI, but
    // the read-only behaviour is a UI concern, not
    // a permission level.
    const effective = role === 'berater' ? 'accountant' : role
    const rank = { viewer: 0, accountant: 1, admin: 2 } as Record<string, number>;
    return (rank[effective] ?? -1) >= (rank[required] ?? 99);
  }

  /**
   * Throw ForbiddenException if the given role cannot perform the action.
   */
  static requireRole(role: string | null | undefined, action: keyof typeof PERMISSIONS) {
    if (!this.can(role, action)) {
      throw new ForbiddenException(`Unzureichende Berechtigung: ${action}`);
    }
  }

  /**
   * List all users in a company (admin only).
   */
  async listCompanyUsers(companyId: string) {
    return this.prisma.user.findMany({
      where: { companyId },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        lastLogin: true,
        profile: true,
      },
      orderBy: [{ createdAt: 'asc' }],
    });
  }

  /**
   * List pending invitations (admin only).
   */
  async listPendingInvitations(companyId: string) {
    return this.prisma.userInvitation.findMany({
      where: {
        companyId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        createdBy: { select: { email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Tier 66: list every company the user has access
   * to. Each row is one UserCompany grant.
   *
   * `activeCompanyId` is the currently-active
   * x-company-id — we mark the matching row
   * `isActive=true` so the UI can render a
   * checkmark next to it.
   *
   * Sort: the active Mandant first (UX), then
   * alphabetical by company name for the rest.
   */
  async listAccessibleCompanies(
    userId: string,
    activeCompanyId?: string,
  ) {
    const rows = await this.prisma.userCompany.findMany({
      where: { userId },
      select: {
        companyId: true,
        role: true,
        grantedAt: true,
        company: {
          select: {
            id: true,
            name: true,
            legalName: true,
            email: true,
          },
        },
      },
      orderBy: [{ company: { name: 'asc' } }],
    })
    return rows.map((r) => ({
      id: r.company.id,
      name: r.company.name,
      legalName: r.company.legalName,
      email: r.company.email,
      role: r.role,
      grantedAt: r.grantedAt,
      isActive: r.companyId === activeCompanyId,
    }))
  }

  /**
   * Tier 66: validate + look up the target Mandant
   * for a switch. Returns null when the user has no
   * UserCompany row for the requested companyId —
   * the controller translates that to a 403.
   */
  async switchActiveCompany(userId: string, targetCompanyId: string) {
    const row = await this.prisma.userCompany.findUnique({
      where: {
        userId_companyId: { userId, companyId: targetCompanyId },
      },
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
    })
    if (!row) return null
    return {
      id: row.company.id,
      name: row.company.name,
      legalName: row.company.legalName,
      role: row.role,
    }
  }

  /**
   * Create an invitation. Returns the raw token (only time it's visible).
   */
  async createInvitation(
    companyId: string,
    invitedById: string,
    email: string,
    role: string,
  ): Promise<{ id: string; email: string; role: string; tokenPlain: string; expiresAt: Date; companyName: string | null }> {
    if (!VALID_ROLES.has(role)) {
      throw new BadRequestException(`Ungültige Rolle: ${role}`);
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new BadRequestException('Ungültige E-Mail-Adresse');
    }

    // Reject if user with that email already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingUser) {
      throw new BadRequestException('Ein Benutzer mit dieser E-Mail-Adresse existiert bereits');
    }

    // Reject if a pending invitation already exists for the same email + company
    const existingInvite = await this.prisma.userInvitation.findFirst({
      where: {
        companyId,
        email: normalizedEmail,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (existingInvite) {
      throw new BadRequestException(
        'Es existiert bereits eine offene Einladung für diese E-Mail-Adresse'
      );
    }

    const tokenPlain = randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(tokenPlain, 10);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invite = await this.prisma.userInvitation.create({
      data: {
        companyId,
        email: normalizedEmail,
        role,
        tokenHash,
        expiresAt,
        createdById: invitedById,
      },
    });

    const company = await this.prisma.company.findUnique({ where: { id: companyId } });

    this.logger.log(`Invitation created: company=${companyId} email=${normalizedEmail} role=${role}`);
    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      tokenPlain,
      expiresAt: invite.expiresAt,
      companyName: company?.name ?? null,
    };
  }

  /**
   * Resend an existing invitation (regenerates the token, extends expiry).
   */
  async resendInvitation(companyId: string, invitationId: string) {
    const inv = await this.prisma.userInvitation.findFirst({
      where: { id: invitationId, companyId, acceptedAt: null },
    });
    if (!inv) throw new NotFoundException('Einladung nicht gefunden');

    const tokenPlain = randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(tokenPlain, 10);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.prisma.userInvitation.update({
      where: { id: inv.id },
      data: { tokenHash, expiresAt },
    });

    return { id: inv.id, email: inv.email, role: inv.role, tokenPlain, expiresAt };
  }

  /**
   * Cancel (delete) a pending invitation.
   */
  async cancelInvitation(companyId: string, invitationId: string) {
    const inv = await this.prisma.userInvitation.findFirst({
      where: { id: invitationId, companyId, acceptedAt: null },
    });
    if (!inv) throw new NotFoundException('Einladung nicht gefunden');
    await this.prisma.userInvitation.delete({ where: { id: inv.id } });
  }

  /**
   * Change a user's role (admin only).
   * Special rule: cannot demote the last admin of a company.
   */
  async changeRole(companyId: string, userId: string, newRole: string) {
    if (!VALID_ROLES.has(newRole)) {
      throw new BadRequestException(`Ungültige Rolle: ${newRole}`);
    }
    const user = await this.prisma.user.findFirst({
      where: { id: userId, companyId },
    });
    if (!user) throw new NotFoundException('Benutzer nicht gefunden');

    if (user.role === ROLES.ADMIN && newRole !== ROLES.ADMIN) {
      // Make sure there's at least one other admin remaining
      const otherAdmins = await this.prisma.user.count({
        where: { companyId, role: ROLES.ADMIN, status: 'active', NOT: { id: userId } },
      });
      if (otherAdmins === 0) {
        throw new BadRequestException(
          'Es muss mindestens ein Administrator mit aktiver Rolle vorhanden sein'
        );
      }
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { role: newRole },
      select: { id: true, email: true, role: true, status: true },
    });
  }

  /**
   * Deactivate a user (admin only). Same last-admin protection.
   */
  async setStatus(companyId: string, userId: string, status: 'active' | 'inactive') {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, companyId },
    });
    if (!user) throw new NotFoundException('Benutzer nicht gefunden');
    if (user.role === ROLES.ADMIN && status === 'inactive') {
      const otherAdmins = await this.prisma.user.count({
        where: { companyId, role: ROLES.ADMIN, status: 'active', NOT: { id: userId } },
      });
      if (otherAdmins === 0) {
        throw new BadRequestException(
          'Es muss mindestens ein aktiver Administrator vorhanden sein'
        );
      }
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: { status },
      select: { id: true, email: true, role: true, status: true },
    });
  }

  /**
   * Verify a raw invitation token and return the invitation if valid.
   */
  async verifyInvitationToken(tokenPlain: string) {
    if (!tokenPlain || tokenPlain.length < 32) return null;
    const candidates = await this.prisma.userInvitation.findMany({
      where: {
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { company: { select: { id: true, name: true } } },
    });
    for (const c of candidates) {
      const ok = await bcrypt.compare(tokenPlain, c.tokenHash);
      if (ok) {
        return {
          id: c.id,
          email: c.email,
          role: c.role,
          companyId: c.companyId,
          companyName: c.company?.name,
          expiresAt: c.expiresAt,
        };
      }
    }
    return null;
  }

  /**
   * Accept an invitation: create the user with the role from the invite
   * and link them to the company. Marks the invitation as accepted.
   */
  async acceptInvitation(
    tokenPlain: string,
    password: string,
  ): Promise<{ user: any; companyId: string; companyName: string | null }> {
    if (password.length < 8) {
      throw new BadRequestException('Passwort muss mindestens 8 Zeichen lang sein');
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      throw new BadRequestException('Passwort muss Buchstaben und Zahlen enthalten');
    }

    const inv = await this.verifyInvitationToken(tokenPlain);
    if (!inv) throw new BadRequestException('Einladung ungültig oder abgelaufen');

    // Reject if user with that email has been created in the meantime
    const existing = await this.prisma.user.findUnique({ where: { email: inv.email } });
    if (existing) throw new BadRequestException('Benutzer existiert bereits');

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        email: inv.email,
        passwordHash,
        companyId: inv.companyId,
        role: inv.role,
        status: 'active',
      },
    });

    await this.prisma.userInvitation.update({
      where: { id: inv.id },
      data: { acceptedAt: new Date() },
    });

    this.logger.log(`Invitation accepted: email=${inv.email} companyId=${inv.companyId} role=${inv.role}`);

    return { user, companyId: inv.companyId, companyName: inv.companyName };
  }
}
