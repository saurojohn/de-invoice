/**
 * Tier 401 — the one place the frontend starts and ends a session.
 *
 * Until Tier 400 the browser's credential was `x-user-id`, read from
 * localStorage and sent on every request: anyone who learned a user's UUID was
 * that user (HANDOFF §9 item 10). The backend now mints a session at login and
 * sets an httpOnly cookie, so the credential is something JavaScript cannot
 * read and an attacker cannot guess.
 *
 * Four routes finish a login and all four mint a session: `/auth/login`,
 * `/auth/2fa/verify`, `/auth/register` and `/invitations/accept`. Each one's
 * page funnels its response through `storeSession()` here.
 *
 * The ids stay in localStorage — they are still needed to *display* who is
 * signed in and to select the active Mandant (`x-company-id`, which was never
 * a credential). What changes is that once a real session exists we stop
 * sending `x-user-id` at all: see `authHeaders()` in api.ts.
 */

export const SESSION_FLAG = "hasSession"

const ONE_DAY = 60 * 60 * 24

/** Response shape shared by the four routes that complete a login. */
export interface LoginLikeResponse {
  id?: string
  userId?: string
  email?: string
  companyId?: string
  /** Present since Tier 400/401 — its presence is what marks a real session. */
  sessionToken?: string
  user?: { id?: string; email?: string; companyId?: string }
  company?: { id?: string }
}

/**
 * Persist what the app needs after a successful login and mark whether the
 * response came with a session.
 *
 * `sessionToken` is deliberately NOT stored: the browser already has the
 * httpOnly cookie, and putting a bearer token in localStorage would recreate
 * exactly the stealable-credential problem this tier removes. We store only
 * the boolean fact that a session exists, so `authHeaders()` knows it may stop
 * sending the legacy header.
 */
export function storeSession(data: LoginLikeResponse): void {
  if (typeof window === "undefined") return
  const userId = data.id || data.userId || data.user?.id || ""
  const companyId = data.companyId || data.user?.companyId || data.company?.id || ""
  const email = data.email || data.user?.email || ""
  if (userId) localStorage.setItem("userId", userId)
  if (companyId) localStorage.setItem("companyId", companyId)
  localStorage.setItem("userEmail", email)
  if (data.sessionToken) {
    localStorage.setItem(SESSION_FLAG, "1")
  } else {
    // An older backend, or a response that carried no session: keep the legacy
    // header path so the app still works against it.
    localStorage.removeItem(SESSION_FLAG)
  }
  // The Next middleware runs on the server and cannot see localStorage, so the
  // Mandant selector is mirrored into a readable cookie. The session cookie
  // itself is set by the backend and is httpOnly — this mirror is a UX gate,
  // never the credential (see src/middleware.ts).
  if (userId) {
    document.cookie = `x-user-id=${encodeURIComponent(userId)}; path=/; max-age=${ONE_DAY}; SameSite=Lax`
  }
  if (companyId) {
    document.cookie = `x-company-id=${encodeURIComponent(companyId)}; path=/; max-age=${ONE_DAY}; SameSite=Lax`
  }
}

/** True when the last login handed us a real server-side session. */
export function hasSession(): boolean {
  if (typeof window === "undefined") return false
  try {
    return localStorage.getItem(SESSION_FLAG) === "1"
  } catch {
    return false
  }
}

/**
 * End the session — server-side first.
 *
 * Before this, "Abmelden" was `localStorage.clear()`: with sessions that would
 * leave a credential valid for its full 30 days in anyone's hands who had the
 * cookie. `/auth/logout` revokes the row and clears the cookie; the local
 * cleanup then removes what the UI reads.
 */
export async function signOut(): Promise<void> {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
  try {
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: "POST",
      // Without this the cookie is not sent cross-origin (3100 → 3001) and the
      // server would have nothing to revoke.
      credentials: "include",
    })
  } catch {
    // A network failure must not strand the user in a half-signed-out UI. The
    // local cleanup below still runs; the session expires on its own.
  }
  if (typeof window === "undefined") return
  try {
    localStorage.clear()
  } catch {
    // private mode / blocked storage
  }
  document.cookie = "x-user-id=; path=/; max-age=0"
  document.cookie = "x-company-id=; path=/; max-age=0"
}
