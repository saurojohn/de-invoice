/**
 * Authenticated fetch helper.
 *
 * Tier 401: the credential is the httpOnly session cookie the backend sets at
 * login, carried by `credentials: "include"`. `x-company-id` still selects the
 * active Mandant, and `x-user-id` is only sent when there is no session (the
 * e2e suites seed ids without logging in) — it used to BE the credential, see
 * HANDOFF §9 item 10. When the company header is missing the backend returns
 * 403 "Unzureichende Berechtigung" and the frontend shows empty data — this is
 * the silent "saved but not displayed" bug.
 *
 * Use apiFetch() instead of raw fetch() for any call to
 * `http://localhost:3001/api/v1/...` from the dashboard.
 *
 * The helper:
 *   - injects x-user-id / x-company-id from localStorage
 *   - injects Content-Type: application/json when a body is sent
 *   - throws ApiError on non-2xx so .catch() actually fires
 */
import { hasSession, SESSION_FLAG } from "./auth"

export class ApiError extends Error {
  status: number
  body: any
  constructor(status: number, body: any, message: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"

function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {}
  // Tier 71: read the "x-readonly" flag from
  // localStorage. When set, every API request
  // is tagged with x-readonly: 1, and the
  // backend rejects all mutations (the
  // Steuerberater-Modus). Default off.
  const readonly = localStorage.getItem("readonly") === "1"
  return {
    // Tier 401: once login has minted a session, the httpOnly cookie IS the
    // credential and this header is not sent at all — production runs with
    // ALLOW_HEADER_AUTH=0, where it would be ignored anyway, and sending it
    // would keep a guessable id travelling on every request for no reason.
    // The fallback stays for the e2e suites (which seed ids without logging
    // in) and for a browser talking to a backend from before Tier 400.
    ...(hasSession() ? {} : { "x-user-id": localStorage.getItem("userId") || "" }),
    // Never a credential: the Mandant selector, validated against UserCompany.
    "x-company-id": localStorage.getItem("companyId") || "",
    ...(readonly ? { "x-readonly": "1" } : {}),
  }
}

interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: any
  /** If true, the function throws ApiError on non-2xx (default: true).
   *  Pass false for requests that need to return 4xx without throwing
   *  (e.g. "is the email already taken" checks). */
  throwOnError?: boolean
}

export async function apiFetch(path: string, opts: ApiFetchOptions = {}): Promise<Response> {
  const { body, throwOnError = true, headers, ...rest } = opts
  const finalHeaders: Record<string, string> = {
    ...authHeaders(),
    ...(headers as Record<string, string> | undefined),
  }
  let finalBody: BodyInit | undefined
  if (body !== undefined && body !== null) {
    if (body instanceof FormData) {
      finalBody = body
      // FormData sets its own multipart Content-Type
      // with boundary — never override.
    } else if (typeof body === "string") {
      // Caller has already JSON-stringified the body.
      // Set Content-Type to application/json so the
      // server-side body parser knows to parse it.
      // Without this, Nest sees no Content-Type and
      // leaves req.body as undefined (the bug we hit
      // in the VoucherTemplate /apply endpoint).
      finalBody = body
      if (!finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
        finalHeaders["Content-Type"] = "application/json"
      }
    } else {
      finalBody = JSON.stringify(body)
      if (!finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
        finalHeaders["Content-Type"] = "application/json"
      }
    }
  }
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`
  // Pass cache: 'no-store' so the browser NEVER serves a stale
  // PDF / JSON response from its HTTP cache. The server is
  // authoritative — even with the cache-bust ?t= query
  // parameter, some browsers (notably Safari) and service
  // workers can still return a cached body. 'no-store' is
  // the explicit opt-out.
  // Tier 401: `credentials: "include"` is what carries the httpOnly session
  // cookie. The dashboard runs on :3100 and the API on :3001, so this is a
  // cross-origin request and the default ("same-origin") would send no cookie
  // at all — and would silently drop the Set-Cookie on login. CORS already
  // answers with Access-Control-Allow-Credentials: true; behind nginx the two
  // are same-origin anyway.
  const res = await fetch(url, {
    cache: "no-store",
    credentials: "include",
    ...rest,
    headers: finalHeaders,
    body: finalBody,
  })
  if (throwOnError && !res.ok) {
    const data = await res.json().catch(() => ({}))
    const msg = Array.isArray(data.message)
      ? data.message.join(", ")
      : data.message || `HTTP ${res.status}`
    // Tier 300: auto-logout on 401. A 401 means our
    // userId/companyId headers are stale or invalid
    // (e.g. PG was rebuilt, fixture-survival rule
    // changed, or a different user logged in on a
    // sibling tab). Without this, every page would
    // show a "Vorlagen konnten nicht geladen werden"
    // toast on first load and the user has to
    // manually log out + in. Throw the error AFTER
    // the cleanup so the original ApiError still
    // surfaces to the caller's catch (the toast
    // may be redundant, but logout is the real fix).
    if (res.status === 401 && typeof window !== "undefined") {
      try {
        localStorage.removeItem("userId")
        localStorage.removeItem("companyId")
        localStorage.removeItem("userEmail")
        // Tier 401: the session is gone too — leaving this set would make
        // authHeaders() keep omitting x-user-id after a re-login against a
        // backend that minted nothing.
        localStorage.removeItem(SESSION_FLAG)
        document.cookie = "x-user-id=; path=/; max-age=0"
        document.cookie = "x-company-id=; path=/; max-age=0"
        // Use replace() so the user can hit back
        // to return to where they were. The
        // dashboard route is what triggered the
        // 401; we redirect to /login so the
        // middleware sees no auth cookie and
        // re-renders the login form.
        const from = window.location.pathname + window.location.search
        // Tier 304: exclude /portal — it uses token-based
        // auth (not the userId/companyId headers), so a
        // 401 there means "bad/expired token", not
        // "stale session". Redirecting to /login would
        // steal the customer away from the portal page
        // (where the portal-error UI is rendered).
        const isPortal = window.location.pathname.startsWith("/portal")
        if (!isPortal && window.location.pathname !== "/login") {
          window.location.replace(
            `/login?from=${encodeURIComponent(from)}&reason=session_expired`,
          )
        }
      } catch {
        // ignore — the throw below still surfaces
      }
    }
    throw new ApiError(res.status, data, msg)
  }
  return res
}

/** GET and parse JSON. Returns \`null\` (typed as T) when
 *  the response body is empty — this happens when a
 *  backend endpoint returns 200 with no body (e.g. an
 *  empty collection). Without this guard, res.json() on
 *  an empty body throws SyntaxError "The string did not
 *  match the expected pattern". Caller code that does
 *  \`Array.isArray(data) ? data : (data?.data || [])\`
 *  still works because \`null\` is not an array. */
export async function apiGet<T = any>(path: string, opts?: { signal?: AbortSignal }): Promise<T> {
  const res = await apiFetch(path, { method: "GET", ...(opts?.signal ? { signal: opts.signal } : {}) })
  const text = await res.text()
  if (!text) return null as unknown as T
  return JSON.parse(text)
}

/** POST JSON and parse JSON. */
export async function apiPost<T = any>(path: string, body?: any): Promise<T> {
  const res = await apiFetch(path, { method: "POST", body })
  return res.json()
}

/** PUT JSON and parse JSON. */
export async function apiPut<T = any>(path: string, body?: any): Promise<T> {
  const res = await apiFetch(path, { method: "PUT", body })
  return res.json()
}

/** PATCH JSON and parse JSON. Used by endpoints
 *  that update a subset of fields (webhook
 *  status pause/resume, user role changes,
 *  etc). The backend treats PATCH semantically
 *  as "merge into existing" — fields not in the
 *  body are left untouched. */
export async function apiPatch<T = any>(path: string, body?: any): Promise<T> {
  const res = await apiFetch(path, { method: "PATCH", body })
  return res.json()
}

/** DELETE. Returns the parsed JSON body typed as T (defaults
 *  to `any` for callers that don't care). Like apiGet, an
 *  empty body parses to {} — never throws on `res.json()`. */
export async function apiDelete<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: "DELETE" })
  return res.json().catch(() => ({} as T))
}

/** GET a binary response (PDF / image / CSV) as a Blob.
 *  Returns the Blob AND the response headers — the journal
 *  PDF endpoint embeds its metadata in X-Journal-* headers
 *  (count, balanced) which the iframe-only UI can't read.
 *  The headers are normalised to a plain Record for
 *  ergonomic access.
 *
 *  We deliberately don't add a `apiPostBlob` — the journal
 *  export is GET-only by design (idempotent, cacheable). */
export async function apiGetBlob(
  path: string,
): Promise<{ blob: Blob; headers: Record<string, string> }> {
  const res = await apiFetch(path, { method: "GET" })
  const blob = await res.blob()
  return { blob, headers: Object.fromEntries(res.headers.entries()) }
}

/** Tier 389: the path of a backend API URL a link or button points at, or null
 *  for anything else. Accepts API_BASE-absolute and relative `/api/v1/…` URLs.
 *  Customer-portal and payment-link routes authenticate with a token in the
 *  URL and still work as plain navigations, so they are left alone. */
export function apiPathOf(href: string): string | null {
  if (typeof window === "undefined" || !href || href === "#") return null
  let url: URL
  try {
    url = new URL(href, window.location.origin)
  } catch {
    return null
  }
  const base = new URL(API_BASE, window.location.origin)
  if (url.origin !== base.origin && url.origin !== window.location.origin) return null
  if (!url.pathname.startsWith("/api/v1/")) return null
  if (/^\/api\/v1\/(customer-portal|pay|payment-links?)\//.test(url.pathname)) return null
  return url.pathname + url.search
}

function filenameFrom(disposition: string | null, path: string): string {
  if (disposition) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)
    if (star) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""))
      } catch {
        // fall through
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)
    if (plain) return plain[1].trim()
  }
  const last = path.split("?")[0].split("/").filter(Boolean).pop()
  return last ? decodeURIComponent(last) : "download"
}

/** Tier 389: download (or open in a new tab) a file from a protected backend
 *  route. A plain navigation — `<a href>`, `window.open` — sends no
 *  x-user-id / x-company-id, and every such route answers 401: measured for
 *  the Anlage / EÜR / GuV / Bilanz PDFs, GoBD archive, BWA, DATEV exports,
 *  activity CSV, UStJA — all 200 with the headers, 401 without. This fetches
 *  with the auth headers and hands the browser a blob.
 *
 *  Call it synchronously from the click handler: with `newTab` the tab is
 *  opened before the fetch so popup blockers see the user gesture. */
export async function downloadApiFile(
  path: string,
  opts: { filename?: string; newTab?: boolean } = {},
): Promise<void> {
  const tab = opts.newTab ? window.open("", "_blank") : null
  try {
    const res = await apiFetch(path, { method: "GET" })
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    setTimeout(() => URL.revokeObjectURL(url), 120_000)
    const viewable = /^(application\/pdf|image\/|text\/plain|text\/html)/.test(blob.type)
    if (tab && viewable) {
      tab.location.href = url
      return
    }
    tab?.close()
    const a = document.createElement("a")
    a.href = url
    a.download = opts.filename || filenameFrom(res.headers.get("content-disposition"), path)
    a.style.display = "none"
    // Marked so the document-level interceptor does not pick it up again.
    a.dataset.apiDownload = "done"
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch (err) {
    tab?.close()
    throw err
  }
}
