import type { User } from '@prisma/client'
import type { PrismaService } from '../prisma/prisma.service'

/**
 * Tier 782 — a user's e-mail address is the same address in any case.
 *
 * Registration stored the address as typed and looked it up as typed;
 * invitations, password reset and the 2FA step lower-cased it. Measured:
 * `Name@Firma.de` registered, then `name@firma.de` registered a second account
 * (another company); `forgot-password` with the address as registered found no
 * account (it looked up the lower-cased one); login with the other case was
 * "Invalid email or password".
 *
 * New addresses are stored lower-case. Lookups take the exact address first —
 * an account stored before this with capitals still signs in — and then the
 * address in any case.
 */
export function normalizeUserEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

export async function findUserByEmail(prisma: PrismaService, raw: unknown): Promise<User | null> {
  const typed = typeof raw === 'string' ? raw.trim() : ''
  if (!typed) return null
  const exact = await prisma.user.findUnique({ where: { email: typed } })
  if (exact) return exact
  return prisma.user.findFirst({
    where: { email: { equals: typed, mode: 'insensitive' } },
    orderBy: { createdAt: 'asc' },
  })
}

/** Whether an account has this address, in any case. */
export async function userEmailTaken(prisma: PrismaService, raw: unknown): Promise<boolean> {
  return !!(await findUserByEmail(prisma, raw))
}
