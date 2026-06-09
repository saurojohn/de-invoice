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

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"

function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {}
  return {
    "x-user-id": localStorage.getItem("userId") || "",
    "x-company-id": localStorage.getItem("companyId") || "",
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
    if (typeof body === "string" || body instanceof FormData) {
      finalBody = body
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
export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: "GET" })
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

/** DELETE. Returns the parsed JSON body typed as T (defaults
 *  to `any` for callers that don't care). Like apiGet, an
 *  empty body parses to {} — never throws on `res.json()`. */
export async function apiDelete<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: "DELETE" })
  return res.json().catch(() => ({} as T))
}
