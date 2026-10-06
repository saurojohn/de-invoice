/**
 * Tier 556 — the address that goes into a mailed link is the installation's,
 * not whatever the request says it is.
 *
 * The customer portal's public "send me a login link" route built the link
 * from `X-Forwarded-Host` / `Host` (measured: `X-Forwarded-Host: evil.example`
 * → the customer was mailed `https://evil.example/portal?token=<real token>`).
 * Password-reset and invitation links took the request's `Origin`, with
 * `http://localhost:<port>` when there was none.
 *
 * A request's own idea of the address is used only when it is one of the
 * configured ones (FRONTEND_URL — the CORS allow-list); otherwise APP_ORIGIN,
 * otherwise the first FRONTEND_URL entry.
 */
type Req = { headers?: Record<string, string | string[] | undefined>; protocol?: string } | undefined

const first = (v: string | string[] | undefined): string =>
  String(Array.isArray(v) ? v[0] : v ?? '').split(',')[0].trim()

export function allowedOrigins(): string[] {
  return String(process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

export function publicOrigin(req?: Req): string {
  const allowed = allowedOrigins()
  const h = req?.headers ?? {}
  const candidates = [first(h.origin)]
  const host = first(h['x-forwarded-host']) || first(h.host)
  if (host) candidates.push(`${first(h['x-forwarded-proto']) || req?.protocol || 'http'}://${host}`)
  for (const c of candidates) {
    const o = c.replace(/\/$/, '')
    if (o && allowed.includes(o)) return o
  }
  return String(process.env.APP_ORIGIN || '').replace(/\/$/, '') || allowed[0]
}
