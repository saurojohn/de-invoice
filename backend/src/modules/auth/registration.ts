/**
 * Tier 820 — who may register a company on this installation.
 *
 * Registration was open to anyone with the address: each registration makes
 * a new company and its admin. Their data is apart from the owner's, and the
 * operator is the first company's admin (system-admin.guard.ts) — but on a
 * server run for one business, strangers could open companies on it, fill
 * its disk, send mail through its SMTP. The owner asked (09.11.2026) that
 * once the first company exists, new people come in by invitation only
 * (Einstellungen → Benutzerverwaltung → Einladen, /register?invite=…, which
 * this does not touch).
 *
 *  - The first company is always registered (an empty installation).
 *  - Then: the operator's choice, kept with the first company
 *    (`settings.registration`, 'open' | 'closed'), set on the user page.
 *  - Unset: `REGISTRATION=first-only` closes it — infra/prod's compose file
 *    sets that; anything else (development, the test suites) leaves it open.
 */
import { PrismaService } from '../../prisma/prisma.service'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { updateCompanySettings } from '../../common/company-settings'

export type RegistrationSetting = 'open' | 'closed'

export async function registrationState(prisma: PrismaService): Promise<{
  open: boolean
  /** where the answer came from */
  source: 'empty' | 'setting' | 'default'
  /** what REGISTRATION gives when nothing is set */
  defaultOpen: boolean
}> {
  const defaultOpen = String(process.env.REGISTRATION || '').trim().toLowerCase() !== 'first-only'
  const first = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { settings: true } })
  if (!first) return { open: true, source: 'empty', defaultOpen }
  const s = (first.settings as Record<string, unknown> | null)?.registration
  if (s === 'open' || s === 'closed') return { open: s === 'open', source: 'setting', defaultOpen }
  return { open: defaultOpen, source: 'default', defaultOpen }
}

/**
 * Tier 825 — the first registration of an empty installation makes its owner
 * the operator (system-admin.guard.ts). Between `docker compose up` and the
 * owner's registration, whoever reached the address first owned the server.
 * With SETUP_TOKEN set (HETZNER-DEPLOY.sh writes one into .env and prints
 * the link `/register?setup=…`), that first registration needs it; once a
 * company exists it plays no part. Unset (development, the test suites),
 * nothing changes.
 */
export function setupTokenRequired(source: 'empty' | 'setting' | 'default', env = process.env): boolean {
  return source === 'empty' && String(env.SETUP_TOKEN || '').trim().length > 0
}

export function setupTokenMatches(given: unknown, env = process.env): boolean {
  const want = Buffer.from(String(env.SETUP_TOKEN || '').trim())
  const got = Buffer.from(typeof given === 'string' ? given.trim() : '')
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want)
}

export const SETUP_TOKEN_MESSAGE =
  'Die erste Registrierung dieser Installation braucht den Einrichtungslink (/register?setup=…), den das Deploy-Skript ausgegeben hat.'

export const REGISTRATION_CLOSED_MESSAGE =
  'Die Registrierung ist geschlossen. Neue Benutzer lädt der Administrator ein (Einstellungen → Benutzerverwaltung).'

/**
 * Tier 821 — an invitation to register a company of one's own while the
 * registration is closed. The owner asked (09.11.2026) to let people they
 * choose open their own company on the installation and write its invoices —
 * without opening the registration to everyone. The operator invites an
 * e-mail address; the link (`/register?company-invite=…`, mailed and shown to
 * the operator once) registers exactly one company, for that address, within
 * INVITE_DAYS. The new company is apart from the operator's: its admin is not
 * the operator (system-admin.guard.ts), its data is its own.
 *
 * Kept with the operator's company (`settings.companyInvites`): the token
 * only as its SHA-256.
 */

export const INVITE_DAYS = 7

export interface CompanyInvite {
  id: string
  email: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  usedAt?: string
  companyId?: string
  revokedAt?: string
}

export type CompanyInviteStatus = 'pending' | 'used' | 'expired' | 'revoked'

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export function inviteStatus(i: CompanyInvite, now = new Date()): CompanyInviteStatus {
  if (i.usedAt) return 'used'
  if (i.revokedAt) return 'revoked'
  return new Date(i.expiresAt) < now ? 'expired' : 'pending'
}

async function firstCompany(prisma: PrismaService) {
  return prisma.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, settings: true } })
}

const invitesOf = (settings: unknown): CompanyInvite[] => {
  const list = (settings as Record<string, unknown> | null)?.companyInvites
  return Array.isArray(list) ? (list as CompanyInvite[]) : []
}

/** The invitation a token names, while it can still be used — else null. */
export async function pendingCompanyInvite(prisma: PrismaService, token: unknown): Promise<CompanyInvite | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const first = await firstCompany(prisma)
  if (!first) return null
  const h = hash(token)
  const found = invitesOf(first.settings).find((i) => i.tokenHash === h)
  return found && inviteStatus(found) === 'pending' ? found : null
}

export async function createCompanyInvite(prisma: PrismaService, operatorCompanyId: string, rawEmail: unknown) {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new BadRequestException('Bitte eine gültige E-Mail-Adresse angeben.')
  }
  const token = randomBytes(32).toString('base64url')
  const now = new Date()
  const invite: CompanyInvite = {
    id: randomUUID(),
    email,
    tokenHash: hash(token),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString(),
  }
  await updateCompanySettings(prisma, operatorCompanyId, (settings) => {
    const list = invitesOf(settings)
    if (list.some((i) => i.email === email && inviteStatus(i) === 'pending')) {
      throw new BadRequestException('Für diese Adresse gibt es schon eine offene Einladung — erst widerrufen, dann neu einladen.')
    }
    ;(settings as Record<string, unknown>).companyInvites = [...list, invite]
  })
  return { invite, token }
}

export async function listCompanyInvites(prisma: PrismaService, operatorCompanyId: string) {
  const c = await prisma.company.findUnique({ where: { id: operatorCompanyId }, select: { settings: true } })
  const now = new Date()
  return invitesOf(c?.settings)
    .map(({ tokenHash: _h, ...rest }) => ({ ...rest, status: inviteStatus(rest as CompanyInvite, now) }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function revokeCompanyInvite(prisma: PrismaService, operatorCompanyId: string, id: string) {
  return updateCompanySettings(prisma, operatorCompanyId, (settings) => {
    const list = invitesOf(settings)
    const found = list.find((i) => i.id === id)
    if (!found) throw new NotFoundException('Einladung nicht gefunden')
    if (inviteStatus(found) !== 'pending') throw new BadRequestException('Diese Einladung ist nicht mehr offen.')
    found.revokedAt = new Date().toISOString()
    ;(settings as Record<string, unknown>).companyInvites = list
    return found
  })
}

/** Marks the invitation used by the company it made (inside the registration's lock). */
export async function useCompanyInvite(prisma: PrismaService, token: string, companyId: string) {
  const first = await firstCompany(prisma)
  if (!first) return
  const h = hash(token)
  await updateCompanySettings(prisma, first.id, (settings) => {
    const list = invitesOf(settings)
    const found = list.find((i) => i.tokenHash === h)
    if (found) {
      found.usedAt = new Date().toISOString()
      found.companyId = companyId
    }
    ;(settings as Record<string, unknown>).companyInvites = list
  })
}

export const COMPANY_INVITE_MISMATCH = 'Die Einladung gilt für eine andere E-Mail-Adresse.'
