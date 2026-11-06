/**
 * Tier 806 — the secret links are kept out of logs and error events.
 *
 * Two routes carry their credential in the path: the calendar feed
 * (GET /calendar/<token>.ics, Tier 805) and the invoice link
 * (/portal/<token>, shown by the page /pay/<token>). The error filter wrote `req.originalUrl` into the log
 * and into the stored error event, so a database hiccup during a calendar
 * poll left a working link on the system error page. A `token` in the query
 * string or among the route parameters is cut the same way.
 */
// the frontend's page of the invoice link is /pay/<token> (app/pay/[token])
const SECRET_PATH = /(\/api\/v1\/(?:calendar|portal)\/|^\/pay\/|\/\/[^/]+\/pay\/)[^/?#\s\]]+/g
const SECRET_QUERY = /([?&](?:token|access_token)=)[^&#]*/gi

export function redactUrl(url: string | null | undefined): string {
  return String(url ?? '').replace(SECRET_PATH, '$1[redacted]').replace(SECRET_QUERY, '$1[redacted]')
}

/** A copy of route params / query without a `token` value. */
export function redactParams<T>(params: T): T {
  if (!params || typeof params !== 'object') return params
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) }
  for (const k of Object.keys(out)) if (/^(token|access_token)$/i.test(k)) out[k] = '[redacted]'
  return out as T
}
