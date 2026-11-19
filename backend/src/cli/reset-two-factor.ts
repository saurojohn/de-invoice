/**
 * Tier 872 — the operator takes a lost second factor away, on the server:
 *
 *   docker compose -f infra/prod/docker-compose.yml run --rm backend \
 *     node dist/cli/reset-two-factor.js <e-mail>
 *
 * For the last administrator of a company, who cannot sign in to have it reset
 * by another one (RUNBOOK §3, „Zwei-Faktor-Anmeldung verloren“). Access to the
 * server is the proof. Audited (`two_factor_reset`, via „server“).
 */
process.env.DISABLE_CRON = '1'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { PrismaService } from '../prisma/prisma.service'
import { UserSessionService } from '../auth/user-session.service'
import { AuditService } from '../modules/audit/audit.service'
import { findUserByEmail } from '../auth/user-email'
import { resetTwoFactor } from '../auth/reset-two-factor'

async function main() {
  const email = (process.argv[2] || '').trim()
  if (!email) {
    console.error('usage: node dist/cli/reset-two-factor.js <e-mail>')
    process.exit(2)
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] })
  try {
    const prisma = app.get(PrismaService)
    const user = await findUserByEmail(prisma, email)
    if (!user) {
      console.error(`no user with the address ${email}`)
      process.exitCode = 1
      return
    }
    if (!user.twoFactorEnabled) {
      console.log(`${user.email} has no second factor — nothing to reset`)
      return
    }
    const { endedSessions } = await resetTwoFactor(
      { prisma, sessions: app.get(UserSessionService), audit: app.get(AuditService) },
      { id: user.id, companyId: user.companyId },
      { userId: null, via: 'server', companyId: user.companyId },
    )
    console.log(`2FA of ${user.email} reset; ${endedSessions} session(s) ended. At the next sign-in the password is enough; a company that asks for 2FA has it set up again.`)
  } finally {
    // the whole application was started; some of its modules keep timers that
    // app.close() leaves running — close it at most 5 s, then end the process
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5_000).unref())])
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(String(e?.message || e))
    process.exit(1)
  })
