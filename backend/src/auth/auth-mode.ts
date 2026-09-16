/**
 * Tier 400 — whether the legacy `x-user-id` header still authenticates.
 *
 * It is ON unless explicitly disabled, so the ~300 existing specs (140 backend,
 * 169 Playwright — 1137 header uses counted in Tier 399) keep working while the
 * session cookie is rolled out. Production sets ALLOW_HEADER_AUTH=0 in
 * infra/prod/.env, after which only the session cookie (or Authorization:
 * Bearer) authenticates.
 */
export function legacyHeaderAuthAllowed(): boolean {
  return process.env.ALLOW_HEADER_AUTH !== '0'
}
