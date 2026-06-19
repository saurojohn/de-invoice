/**
 * Public API base URL helper.
 *
 * Mirrors the same logic in lib/api.ts (which keeps
 * API_BASE private) but exported as a function so
 * code that runs OUTSIDE the apiFetch wrapper
 * (e.g. window.onerror capture, plain fetch from
 * service workers) can still hit the backend.
 *
 * Returns the base URL with no trailing slash.
 * Callers add the path themselves.
 */
export function apiBase(): string {
  if (typeof window === "undefined") {
    // SSR: use env var, fall back to localhost.
    return process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
  }
  // Client: read the same env var so dev/prod
  // consistency is automatic.
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
}
