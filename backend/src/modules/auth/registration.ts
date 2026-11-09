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

export const REGISTRATION_CLOSED_MESSAGE =
  'Die Registrierung ist geschlossen. Neue Benutzer lädt der Administrator ein (Einstellungen → Benutzerverwaltung).'
