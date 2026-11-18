/**
 * Tier 861 — administrators sign in with a second factor (security audit,
 * item 8).
 *
 * 2FA was optional for everybody. An administrator's password alone opened
 * the company's books, its users, its bank connection and its settings —
 * a leaked or guessed password was enough.
 *
 * Each company decides (the owner's choice, 18.11.2026):
 * `Company.settings.requireAdmin2fa`. When the company has not set it, it is
 * on in production and off elsewhere (development, the test suites). An
 * administrator without 2FA in such a company reaches only what setting it up
 * takes; every other request is refused with the code TWO_FACTOR_REQUIRED,
 * and the frontend sends them to the security page. Turning the rule off is
 * one of the refused requests — it takes an administrator with 2FA.
 */

export const TWO_FACTOR_REQUIRED_CODE = 'TWO_FACTOR_REQUIRED'

export const TWO_FACTOR_REQUIRED_MESSAGE =
  'Diese Firma verlangt für Administratoren die Zwei-Faktor-Anmeldung. Richten Sie sie unter „Sicherheit“ ein — bis dahin ist nur diese Seite erreichbar.'

/** whether the company asks its administrators for 2FA, and why */
export function adminTwoFactorPolicy(settings: unknown, env: Record<string, string | undefined> = process.env): { required: boolean; source: 'setting' | 'default' } {
  const v = (settings as Record<string, unknown> | null | undefined)?.requireAdmin2fa
  if (v === true || v === false) return { required: v, source: 'setting' }
  return { required: env.NODE_ENV === 'production', source: 'default' }
}

/**
 * What an administrator without 2FA may still do in such a company: see who
 * they are and which companies they have (and switch to another), sign out,
 * change their password,
 * confirm their address — and set up 2FA. (method and path after /api/v1)
 */
const SETUP_ROUTES = new Set([
  'GET /auth/me',
  'POST /auth/logout',
  'POST /auth/change-password',
  'POST /auth/resend-verification',
  'POST /auth/2fa/status',
  'POST /auth/2fa/setup',
  'POST /auth/2fa/enable',
  'GET /auth/2fa/policy',
  'GET /users/me/companies',
  // to a company of theirs that does not ask it
  'POST /users/me/switch-company',
])

export function allowedWithoutTwoFactor(method: string, originalUrl: string): boolean {
  const path = String(originalUrl || '').split('?')[0].replace(/^\/api\/v1(?=\/)/, '').replace(/\/+$/, '')
  return SETUP_ROUTES.has(`${String(method).toUpperCase()} ${path}`)
}
