import { createHash } from 'crypto'

/**
 * Tier 785 — the form in which a random bearer token is stored.
 *
 * The tokens (sessions, portal sessions, reset and invitation links) are 32
 * random bytes: a fast hash is enough to make a copy of the table useless for
 * signing in, and unlike bcrypt it can be looked up by an index.
 */
export function tokenHash(token: string): string {
  // A missing token (no header, an array from a repeated query parameter)
  // hashes like the empty one: it finds no row instead of throwing.
  return createHash('sha256').update(typeof token === 'string' ? token : '').digest('hex')
}
