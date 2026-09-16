"use client"

/**
 * Frontend error capture — global window.onerror +
 * unhandledrejection handlers that POST every
 * unhandled error to the backend ErrorEvent table
 * (self-hosted Sentry).
 *
 * Why not a 3rd-party service?
 *   - 1 SDK, 1 hook, 1 dsn — that's all
 *   - Self-hosted: no PII leakage, no rate limit,
 *     no "free tier" surprise
 *   - Pairs with the global NestJS exception
 *     filter so backend + frontend errors land
 *     in the same table / same dashboard
 *
 * The capture is best-effort: if the network is
 * down (probably WHY the error fired), the POST
 * will fail silently. We never want error capture
 * to throw a new error.
 */
import { useEffect } from "react"
import { apiBase } from "@/lib/apiBase"

/**
 * Tier 392: the fingerprint is no longer computed here. It decided which group
 * the backend row joined, and the public capture route trusted it — a post with
 * an existing group's fingerprint rewrote that group's message (measured). The
 * local hash was also only 32-bit, so unrelated real errors could collide and
 * clobber each other. The server now derives it from message + first stack frame.
 */

let _installed = false

export function useErrorCapture() {
  useEffect(() => {
    if (_installed || typeof window === "undefined") return
    _installed = true

    const postError = (payload: any) => {
      try {
        const body = JSON.stringify(payload)
        // Beacon would be safer for unload events,
        // but fetch keeps the request inspectable in
        // dev tools. fire-and-forget.
        fetch(`${apiBase()}/api/v1/system/errors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          // Don't add keepalive — let the browser
          // close the tab if needed. Capture is
          // best-effort.
        }).catch(() => {})
      } catch {
        // Swallow — never throw from error capture.
      }
    }

    const onError = (event: ErrorEvent) => {
      postError({
        message: event.message || "Unknown error",
        stack: event.error?.stack,
        url: window.location.pathname + window.location.search,
        kind: "unhandled",
        browser: navigator.userAgent,
        context: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      })
    }

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      const message =
        reason?.message ||
        (typeof reason === "string" ? reason : "Unhandled promise rejection")
      const stack = reason?.stack
      postError({
        message,
        stack,
        url: window.location.pathname + window.location.search,
        kind: "unhandled",
        browser: navigator.userAgent,
        context: { type: "unhandledrejection" },
      })
    }

    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onRejection)
    return () => {
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onRejection)
      _installed = false
    }
  }, [])
}

/**
 * Manual capture — call from a React error boundary
 * when the boundary catches a render-time error.
 * Use the `kind: 'boundary'` so the dashboard can
 * distinguish React render errors from raw
 * unhandled errors.
 */
export function reportBoundaryError(
  error: Error,
  componentStack: string,
) {
  if (typeof window === "undefined") return
  try {
    fetch(`${apiBase()}/api/v1/system/errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: `${error.stack}\n\nComponent stack:\n${componentStack}`,
        url: window.location.pathname + window.location.search,
        kind: "boundary",
        browser: navigator.userAgent,
      }),
    }).catch(() => {})
  } catch {
    // Swallow
  }
}
