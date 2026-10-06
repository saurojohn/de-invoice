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
  // Tier 555: in production the header is off unless someone turns it on.
  // It was on unless turned off — and infra/prod/docker-compose.yml hands the
  // backend an explicit `environment:` list that did not contain the flag, so
  // an `ALLOW_HEADER_AUTH=0` in infra/prod/.env never reached the process:
  // whoever knew a user's id (every colleague's is in GET /users) was that
  // user, without a password. Outside production the default stays on (the
  // specs authenticate by header).
  const flag = process.env.ALLOW_HEADER_AUTH
  if (flag === '0') return false
  if (flag === '1') return true
  return process.env.NODE_ENV !== 'production'
}
