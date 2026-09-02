/**
 * Authenticated fetch helper.
 *
 * Every protected backend route requires the `x-user-id` and `x-company-id`
 * headers (set by HeaderAuthGuard). When these are missing, the backend
 * returns 403 "Unzureichende Berechtigung" and the frontend ends up
 * showing empty data — this is the silent "saved but not displayed" bug.
 *
 * Use apiFetch() instead of raw fetch() for any call to
 * `http://localhost:3001/api/v1/...` from the dashboard.
 *
 * The helper:
 *   - injects x-user-id / x-company-id from localStorage
 *   - injects Content-Type: application/json when a body is sent
 *   - throws ApiError on non-2xx so .catch() actually fires
 */
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
    "x-user-id": localStorage.getItem("userId") || "",
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
  const res = await fetch(url, { cache: "no-store", ...rest, headers: finalHeaders, body: finalBody })
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
        document.cookie = "x-user-id=; path=/; max-age=0"
        document.cookie = "x-company-id=; path=/; max-age=0"
        // Use replace() so the user can hit back
        // to return to where they were. The
        // dashboard route is what triggered the
        // 401; we redirect to /login so the
        // middleware sees no auth cookie and
        // re-renders the login form.
        const from = window.location.pathname + window.location.search
        if (window.location.pathname !== "/login") {
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
