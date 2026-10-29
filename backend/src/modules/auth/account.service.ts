import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Tier 737 — the signed-in person's own data, and the end of the account.
 *
 * The export is what the installation keeps about the person (Art. 15 / 20
 * DSGVO): the account, the memberships, the sign-ins (time, IP address,
 * browser), the person's rows of the audit log, the invitations sent, the
 * e-mails sent. Secrets (password hash, 2FA secret and codes, tokens) are not
 * data about the person but keys, and stay out. The company's business
 * records belong to the company; an admin exports them with the GoBD export.
 *
 * Deleting the account anonymises it instead of removing the row: invoices,
 * vouchers, cash book entries and other records point at the user who made
 * them, and the law keeps those records (§ 147 AO, § 257 HGB) — with the row
 * kept, they stay intact and no longer name the person. Address, name,
 * password, 2FA, sessions, memberships and the signing key go. The audit log
 * keeps its rows (they are the GoBD trail, signed into a hash chain) with the
 * user's id only.
 *
 * A company in which the person is the only active member is closed with the
 * account (Company.closedAt): nobody can sign in to it, no job runs for it,
 * and its records are kept until 31.12. of the tenth year after the closing.
 * A company in which the person is the last admin while others remain blocks
 * the deletion — it must not be left without an admin.
 */
export interface DeletionPlan {
  blockers: Array<{ companyId: string; companyName: string; reason: 'last-admin' | 'operator-company' }>;
  closes: Array<{ companyId: string; companyName: string; retentionUntil: string }>;
  leaves: Array<{ companyId: string; companyName: string }>;
}

/** 31.12. of the tenth year after `closedAt` (§ 147 Abs. 4 AO: the period starts at the end of the calendar year) */
export function retentionUntilFor(closedAt: Date): Date {
  return new Date(Date.UTC(closedAt.getUTCFullYear() + 10, 11, 31));
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async exportPersonalData(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, role: true, status: true, profile: true, preferences: true,
        createdAt: true, lastLogin: true, emailVerifiedAt: true,
        twoFactorEnabled: true, twoFactorConfirmedAt: true, companyId: true,
      },
    });
    if (!user) throw new BadRequestException('Benutzer nicht gefunden');
    const [memberships, sessions, activity, invitations, emails] = await Promise.all([
      this.prisma.userCompany.findMany({
        where: { userId },
        select: { role: true, grantedAt: true, company: { select: { id: true, name: true, legalName: true } } },
      }),
      this.prisma.userSession.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true, ipAddress: true, userAgent: true },
      }),
      this.prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, companyId: true, action: true, entityType: true, entityId: true, ipAddress: true, userAgent: true },
      }),
      this.prisma.userInvitation.findMany({
        where: { createdById: userId },
        orderBy: { createdAt: 'asc' },
        select: { email: true, role: true, companyId: true, createdAt: true, expiresAt: true, acceptedAt: true },
      }),
      this.prisma.emailSend.findMany({
        where: { createdById: userId },
        orderBy: { sentAt: 'asc' },
        select: { companyId: true, templateType: true, recipientEmail: true, subject: true, status: true, sentAt: true },
      }),
    ]);
    await this.audit
      .writeActivity({ companyId: user.companyId ?? null, userId, action: 'personal_data_exported', entityType: 'auth', entityId: userId })
      .catch(() => undefined);
    const { companyId: homeCompanyId, ...account } = user;
    return {
      exportedAt: new Date().toISOString(),
      about:
        'Die Daten, die de-invoice über Sie als Person speichert (Art. 15 und 20 DSGVO). Nicht enthalten: Passwort-Hash, ' +
        '2FA-Geheimnis und Wiederherstellungscodes, Anmelde-Token (Schlüssel, keine Angaben über Sie). Die Geschäftsunterlagen ' +
        'der Firma (Rechnungen, Kunden, Buchungen) gehören der Firma; ein Administrator exportiert sie mit dem GoBD-Export.',
      account: { ...account, homeCompanyId },
      memberships: memberships.map((m) => ({ companyId: m.company.id, companyName: m.company.legalName || m.company.name, role: m.role, since: m.grantedAt })),
      sessions,
      activity,
      invitationsSent: invitations,
      emailsSent: emails,
    };
  }

  /** What deleting the account would do — and whether it may. */
  async deletionPlan(userId: string): Promise<DeletionPlan> {
    const memberships = await this.prisma.userCompany.findMany({
      where: { userId },
      select: { role: true, company: { select: { id: true, name: true, legalName: true, closedAt: true } } },
    });
    const plan: DeletionPlan = { blockers: [], closes: [], leaves: [] };
    // The installation's operator is an admin of its oldest company
    // (isSystemAdmin): closing that one leaves the installation without an
    // operator, its imprint without a provider. Not through self-service.
    const operatorCompany = await this.prisma.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    const retention = retentionUntilFor(new Date()).toISOString();
    for (const m of memberships) {
      const c = m.company;
      const companyName = c.legalName || c.name;
      if (c.closedAt) { plan.leaves.push({ companyId: c.id, companyName }); continue; }
      const others = await this.prisma.userCompany.findMany({
        where: { companyId: c.id, userId: { not: userId }, user: { status: 'active' } },
        select: { role: true },
      });
      if (others.length === 0 && c.id === operatorCompany?.id) plan.blockers.push({ companyId: c.id, companyName, reason: 'operator-company' });
      else if (others.length === 0) plan.closes.push({ companyId: c.id, companyName, retentionUntil: retention });
      else if (m.role === 'admin' && !others.some((o) => o.role === 'admin')) plan.blockers.push({ companyId: c.id, companyName, reason: 'last-admin' });
      else plan.leaves.push({ companyId: c.id, companyName });
    }
    return plan;
  }

  async deleteAccount(userId: string, password: string, closeCompanies: boolean): Promise<{ closedCompanies: DeletionPlan['closes'] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, passwordHash: true, companyId: true } });
    if (!user || !password || !(await bcrypt.compare(password, user.passwordHash))) {
      // 400, not 401: the session is fine (the frontend signs out on a 401)
      throw new BadRequestException('Das Passwort ist nicht richtig.');
    }
    const plan = await this.deletionPlan(userId);
    const operator = plan.blockers.find((b) => b.reason === 'operator-company');
    if (operator) {
      throw new BadRequestException(
        `„${operator.companyName}“ ist die Firma des Betreibers dieser Installation und kann nicht mit einem Konto geschlossen werden. Ernennen Sie zuerst einen weiteren Administrator.`,
      );
    }
    if (plan.blockers.length) {
      throw new BadRequestException(
        `Sie sind der letzte Administrator von ${plan.blockers.map((b) => `„${b.companyName}“`).join(', ')}, es gibt dort aber weitere Mitglieder. ` +
        'Ernennen Sie zuerst jemanden zum Administrator oder entfernen Sie die Mitglieder.',
      );
    }
    if (plan.closes.length && !closeCompanies) {
      throw new BadRequestException(
        `Mit dem Konto werden ${plan.closes.map((c) => `„${c.companyName}“`).join(', ')} geschlossen (Sie sind dort das einzige Mitglied). Bitte bestätigen Sie das.`,
      );
    }
    const now = new Date();
    const closedIds = plan.closes.map((c) => c.companyId);
    await this.prisma.$transaction(async (tx) => {
      if (closedIds.length) {
        await tx.company.updateMany({
          where: { id: { in: closedIds }, closedAt: null },
          data: { closedAt: now, closedById: userId, retentionUntil: retentionUntilFor(now) },
        });
        // Nobody of the company is left to accept an invitation or to answer
        // a customer in the portal.
        await tx.userInvitation.updateMany({ where: { companyId: { in: closedIds }, acceptedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
        await tx.customerPortalSession.updateMany({ where: { companyId: { in: closedIds }, expiresAt: { gt: now } }, data: { expiresAt: now } });
        await tx.paymentLink.updateMany({ where: { invoice: { companyId: { in: closedIds } }, revokedAt: null }, data: { revokedAt: now } });
      }
      await tx.userCompany.deleteMany({ where: { userId } });
      await tx.userSigningKey.deleteMany({ where: { userId } });
      // The sign-ins carry the IP address and the browser — personal data
      // with no use once nobody can sign in as this user.
      await tx.userSession.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          email: `geloescht-${userId}@deleted.invalid`,
          passwordHash: await bcrypt.hash(randomBytes(32).toString('hex'), 10),
          status: 'deleted',
          companyId: null,
          profile: Prisma.DbNull,
          preferences: Prisma.DbNull,
          lastLogin: null,
          passwordResetToken: null,
          passwordResetExpires: null,
          emailVerifiedAt: null,
          emailVerifyTokenHash: null,
          emailVerifyExpires: null,
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorConfirmedAt: null,
          recoveryCodes: Prisma.DbNull,
        },
      });
    });
    for (const c of plan.closes) {
      await this.audit
        .writeActivity({ companyId: c.companyId, userId, action: 'company_closed', entityType: 'company', entityId: c.companyId, metadata: { retentionUntil: retentionUntilFor(now).toISOString() } })
        .catch(() => undefined);
    }
    await this.audit
      .writeActivity({ companyId: user.companyId ?? null, userId, action: 'account_deleted', entityType: 'auth', entityId: userId, metadata: { closedCompanies: closedIds, leftCompanies: plan.leaves.map((l) => l.companyId) } })
      .catch(() => undefined);
    this.logger.log(`account ${userId} deleted (anonymised); closed companies: ${closedIds.join(', ') || '-'}`);
    return { closedCompanies: plan.closes };
  }
}
