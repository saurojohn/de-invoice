import { Injectable, Logger } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Tier 400 — browser sessions for logged-in users (HANDOFF §9 item 10).
 *
 * Until now `x-user-id` was the credential: the guard looked the id up and let
 * the request through, so knowing a user's UUID was enough to be that user.
 * Login now mints a session and sets an httpOnly cookie; the guard resolves the
 * cookie (or `Authorization: Bearer`) to the user.
 *
 * Shape and sliding-expiry behaviour are taken from CustomerPortalSession,
 * which has carried the customer portal since Tier 130. Session length is 30
 * days, sliding — the operator's choice (Tier 399).
 */
export const SESSION_COOKIE = 'de_session'
export const SESSION_TTL_DAYS = 30
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
/** Don't write lastSeenAt/expiresAt on every single request. */
const SLIDE_THROTTLE_MS = 60 * 60 * 1000
/**
 * Tier 403 — how long a dead session row is kept before the cleanup cron drops
 * it. Long past any use as a credential (30 days), short enough that the table
 * stays bounded; the window is what lets an operator answer "who was signed in
 * last quarter" from the row rather than only from AuditLog.
 */
export const SESSION_RETENTION_DAYS = 90

export interface ResolvedSession {
  sessionId: string
  userId: string
}

@Injectable()
export class UserSessionService {
  private readonly logger = new Logger(UserSessionService.name)

  constructor(private prisma: PrismaService) {}

  /** Read the session token from the cookie header or an Authorization: Bearer. */
  static tokenFromRequest(req: {
    headers?: Record<string, unknown>
  }): string | null {
    const headers = req?.headers ?? {}
    const auth = headers['authorization']
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      const t = auth.slice(7).trim()
      if (t) return t
    }
    // No cookie-parser in this app — parse the header directly rather than add
    // a dependency for one cookie.
    const raw = headers['cookie']
    if (typeof raw !== 'string') return null
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue
      const value = part.slice(eq + 1).trim()
      return value ? decodeURIComponent(value) : null
    }
    return null
  }

  async create(
    userId: string,
    meta: { ipAddress?: string | null; userAgent?: string | null } = {},
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    await this.prisma.userSession.create({
      data: {
        userId,
        token,
        expiresAt,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    })
    return { token, expiresAt }
  }

  /**
   * Tier 401 — mint a session for a request that has just proved who the user
   * is, and set the cookie on the response. There are four such places
   * (password login, 2FA verify, registration, invitation accept) and all four
   * must mint one: with `ALLOW_HEADER_AUTH=0` a caller who finishes any of them
   * without a session simply cannot use the app.
   */
  async issue(
    res: { setHeader(name: string, value: string): unknown },
    userId: string,
    req?: { ip?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string } },
    ipOverride?: string | null,
  ): Promise<{ token: string; expiresAt: Date }> {
    const session = await this.create(userId, {
      ipAddress: ipOverride ?? req?.ip ?? req?.socket?.remoteAddress ?? null,
      userAgent: (req?.headers?.['user-agent'] as string) ?? null,
    })
    res.setHeader(
      'Set-Cookie',
      UserSessionService.cookie(session.token, SESSION_TTL_DAYS * 24 * 60 * 60),
    )
    return session
  }

  /**
   * Resolve a token to its user, or null when it is unknown, revoked or
   * expired. Slides the expiry (at most hourly, to keep this to one write per
   * session per hour rather than one per request).
   */
  async resolve(token: string): Promise<ResolvedSession | null> {
    if (!token) return null
    const session = await this.prisma.userSession.findUnique({
      where: { token },
      select: { id: true, userId: true, expiresAt: true, revokedAt: true, lastSeenAt: true },
    })
    if (!session || session.revokedAt) return null
    const now = Date.now()
    if (session.expiresAt.getTime() <= now) return null
    if (now - session.lastSeenAt.getTime() > SLIDE_THROTTLE_MS) {
      await this.prisma.userSession
        .update({
          where: { id: session.id },
          data: { lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_TTL_MS) },
        })
        .catch(() => {
          // A slide that loses a race must never fail the request.
        })
    }
    return { sessionId: session.id, userId: session.userId }
  }

  /**
   * Tier 403 — end every session a user has.
   *
   * A password reset is the move someone makes when they believe their account
   * is in the wrong hands; leaving the existing sessions alive would let the
   * intruder keep working for the full 30 days. Returns how many were ended so
   * the caller can log it.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    if (!userId) return 0
    const { count } = await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return count
  }

  /**
   * Tier 403 — drop sessions that expired long ago.
   *
   * Rows are kept well past their expiry on purpose: a revoked or expired row
   * still answers "who was signed in, from where, when" for the audit trail.
   * What they must not do is grow without bound, which is what they did until
   * this existed (nothing ever deleted one, here or in CustomerPortalSession).
   */
  async purgeExpired(olderThanDays = SESSION_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    const { count } = await this.prisma.userSession.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    })
    return count
  }

  async revoke(token: string): Promise<void> {
    if (!token) return
    await this.prisma.userSession
      .updateMany({ where: { token, revokedAt: null }, data: { revokedAt: new Date() } })
      .catch((e: unknown) => this.logger.warn(`session revoke failed: ${(e as Error)?.message ?? e}`))
  }

  /** The Set-Cookie value. Secure only in production — dev runs on plain http. */
  static cookie(token: string, maxAgeSeconds: number): string {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ]
    if (process.env.NODE_ENV === 'production') parts.push('Secure')
    return parts.join('; ')
  }

  static clearedCookie(): string {
    return UserSessionService.cookie('', 0)
  }
}
