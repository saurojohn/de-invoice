import { createHash, randomBytes } from 'crypto'

/**
 * Tier 780 — the step between a correct password and the 2FA code.
 *
 * /auth/login answered a 2FA user with `{ twoFactorRequired, email }` and
 * nothing else, and /auth/2fa/verify took `{ email, code }`: the e-mail and a
 * six-digit code were a login, the password was never needed. Measured: with
 * an attacker's code in the victim's account (see two-factor.controller.ts),
 * verify answered 201 with a session for the victim and no password at all —
 * and for any 2FA account a guessed code was enough, at the global 600 requests
 * a minute.
 *
 * Login now hands out a challenge, and verify takes the challenge instead of
 * the e-mail. A challenge is valid five minutes and for five wrong codes; then
 * the password has to be given again (which login locks after five failures).
 *
 * Held in memory like the pending 2FA setup secrets: a restart ends the
 * challenges, and the user signs in again. Only a hash of the token is kept.
 */
const CHALLENGE_TTL_MS = 5 * 60_000
export const CHALLENGE_MAX_TRIES = 5

const challenges = new Map<string, { userId: string; expiresAt: number; tries: number }>()

function keyOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function gc(now: number) {
  for (const [k, c] of challenges.entries()) {
    if (c.expiresAt <= now) challenges.delete(k)
  }
}

/** A new challenge for a user whose password was just accepted. */
export function issueTwoFactorChallenge(userId: string): string {
  const now = Date.now()
  gc(now)
  const token = randomBytes(32).toString('hex')
  challenges.set(keyOf(token), { userId, expiresAt: now + CHALLENGE_TTL_MS, tries: 0 })
  return token
}

/** The user a live challenge belongs to, or null. */
export function twoFactorChallengeUser(token: unknown): string | null {
  if (typeof token !== 'string' || !token) return null
  const c = challenges.get(keyOf(token))
  if (!c) return null
  if (c.expiresAt <= Date.now()) {
    challenges.delete(keyOf(token))
    return null
  }
  return c.userId
}

/** A wrong code: counts it, and ends the challenge at the limit. Returns the tries left. */
export function failTwoFactorChallenge(token: string): number {
  const k = keyOf(token)
  const c = challenges.get(k)
  if (!c) return 0
  c.tries += 1
  const left = CHALLENGE_MAX_TRIES - c.tries
  if (left <= 0) challenges.delete(k)
  return Math.max(0, left)
}

/** The challenge is used up (a session was issued, or the user cannot finish). */
export function endTwoFactorChallenge(token: string): void {
  challenges.delete(keyOf(token))
}
