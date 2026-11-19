/**
 * Tier 403 — nightly cleanup of dead session rows.
 *
 * Nothing ever deleted a session. `UserSession` (Tier 400) and the
 * `CustomerPortalSession` that has carried the customer portal since Tier 130
 * both grow one row per sign-in, for ever: a company with 20 users who log in
 * daily adds ~7000 rows a year, and the portal one grows with every magic link
 * a customer clicks.
 *
 * Rows are kept well past their expiry on purpose — a dead row still answers
 * "who was signed in, from which address, when", which is the kind of question
 * a GoBD audit or an incident review asks. `SESSION_RETENTION_DAYS` (90) is the
 * window; past it a row is neither a credential nor evidence anyone will reach
 * for, so it goes.
 *
 * Schedule: 03:30 Europe/Berlin — after the 03:00 cron-health check and clear
 * of the 04:00 backup, so a big delete never overlaps the dump.
 */
import { Prisma } from '@prisma/client'
import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { CronHealthService } from '../modules/admin/cron-health.service'
import { SESSION_RETENTION_DAYS, UserSessionService } from './user-session.service'

/** Tier 876: how long the audit log keeps a row's IP address and user agent */
export const AUDIT_NETWORK_RETENTION_DAYS = 90

@Injectable()
export class SessionCleanupScheduler {
  private readonly logger = new Logger(SessionCleanupScheduler.name)

  constructor(
    private prisma: PrismaService,
    private sessions: UserSessionService,
    private health: CronHealthService,
  ) {}

  @Cron('30 3 * * *', {
    name: 'session-cleanup',
    timeZone: 'Europe/Berlin',
  })
  async nightlyCleanup() {
    if (process.env.DISABLE_CRON === '1') {
      this.logger.debug('Skipping (DISABLE_CRON=1)')
      return
    }
    return this.health.wrap('session-cleanup', async () => this.run())
  }

  /**
   * The body, callable directly so the e2e spec can fire it through
   * `POST /admin/cron/session-cleanup/run` and assert on the counts.
   */
  async run(): Promise<{ userSessions: number; portalSessions: number; auditNetworkCleared: number }> {
    const userSessions = await this.sessions.purgeExpired()
    const cutoff = new Date(
      Date.now() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    )
    const { count: portalSessions } = await this.prisma.customerPortalSession.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    })
    const auditNetworkCleared = await this.clearOldAuditNetworkData()
    this.logger.log(
      `session cleanup: ${userSessions} user + ${portalSessions} portal rows older than ${SESSION_RETENTION_DAYS} days; ` +
        `address and browser cleared from ${auditNetworkCleared} audit rows older than ${AUDIT_NETWORK_RETENTION_DAYS} days`,
    )
    return { userSessions, portalSessions, auditNetworkCleared }
  }

  /**
   * Tier 876 — the audit log keeps who did what for the GoBD period, but not
   * from which address with which browser beyond 90 days (the owner's choice,
   * 19.11.2026; DSGVO Art. 5 Abs. 1 lit. e). Every audit row carried the
   * client's IP address and user agent for good. They are not part of the
   * row's hash (computeAuditHash), so clearing them leaves the chain intact.
   * In batches, so a first run over years of rows holds no long lock.
   */
  async clearOldAuditNetworkData(opts: { now?: Date; companyId?: string } = {}): Promise<number> {
    const now = opts.now ?? new Date()
    const before = new Date(now.getTime() - AUDIT_NETWORK_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    // (one company only: for the spec, on a database other specs share)
    const company = opts.companyId ? Prisma.sql`AND "companyId" = ${opts.companyId}` : Prisma.empty
    let cleared = 0
    for (;;) {
      const n = await this.prisma.$executeRaw`
        UPDATE "AuditLog" SET "ipAddress" = NULL, "userAgent" = NULL
        WHERE id IN (
          SELECT id FROM "AuditLog"
          WHERE "createdAt" < ${before} AND ("ipAddress" IS NOT NULL OR "userAgent" IS NOT NULL) ${company}
          LIMIT 20000
        )`
      cleared += n
      if (n < 20000) return cleared
    }
  }
}
