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
