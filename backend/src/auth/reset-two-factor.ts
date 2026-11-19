import { Prisma } from '@prisma/client'
import type { PrismaService } from '../prisma/prisma.service'
import type { UserSessionService } from './user-session.service'
import type { AuditService } from '../modules/audit/audit.service'

/**
 * Tier 872 — a second factor that is lost can be taken away again.
 *
 * Since Tier 861 a production company asks its administrators for 2FA. There
 * was no way back for someone who lost the phone and the recovery codes: no
 * administrator could reset a member's 2FA, and the only administrator of a
 * company was locked out of it for good — short of editing the database.
 *
 * Two ways now, both audited:
 *   - an administrator resets a member's 2FA (POST /users/:id/two-factor/reset;
 *     while the company asks for 2FA, only an administrator who uses it gets
 *     there — HeaderAuthGuard);
 *   - the operator on the server, for the last administrator:
 *     `docker compose run --rm backend node dist/cli/reset-two-factor.js <e-mail>`.
 * The member's sessions end; at the next sign-in the password is enough, and a
 * company that asks for 2FA asks for it to be set up again.
 */
export async function resetTwoFactor(
  deps: { prisma: PrismaService; sessions: UserSessionService; audit: AuditService },
  target: { id: string; companyId: string | null },
  by: { userId: string | null; via: 'admin' | 'server'; companyId: string | null },
): Promise<{ endedSessions: number }> {
  await deps.prisma.user.update({
    where: { id: target.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorConfirmedAt: null, recoveryCodes: Prisma.DbNull, twoFactorLastStep: null },
  })
  const endedSessions = await deps.sessions.revokeAllForUser(target.id)
  await deps.audit.writeActivity({
    companyId: by.companyId ?? target.companyId,
    userId: by.userId,
    action: 'two_factor_reset',
    entityType: 'auth',
    entityId: target.id,
    metadata: { via: by.via, endedSessions },
  })
  return { endedSessions }
}
