"use client"

/**
 * Tier 71: Steuerberater-Modus (Read-Only Modus).
 *
 * Renders a sticky banner at the top of every
 * dashboard page when "Read-Only Modus" is
 * active, plus a toggle in the header that
 * flips the localStorage flag the apiFetch
 * helper reads.
 *
 * How the read-only mode works:
 *   1. The user clicks the toggle.
 *   2. We set localStorage("readonly") = "1".
 *   3. apiFetch adds `x-readonly: 1` to every
 *      request.
 *   4. The backend RolesGuard checks
 *      req.user.readonly and 403s any
 *      non-`*.read` action.
 *
 * What the UI does on top of the backend:
 *   - Banner visible at the top of every page.
 *   - All `Button` components used for write
 *     actions are disabled (or, ideally, not
 *     rendered). The pattern in this codebase
 *     is: each page that has write buttons
 *     reads the `useReadOnly()` hook and
 *     conditionally renders the button.
 *     This component owns the hook.
 *
 * Per-browser, per-tab: the localStorage value
 * is shared across all tabs in the same origin.
 * Reload-anywhere preserves the setting.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"

interface ReadOnlyContextValue {
  /** True when the read-only mode is active. */
  readonly: boolean
  /** Flip the mode. Pass true to force on, false
   *  to force off, undefined to toggle. */
  setReadonly: (next?: boolean) => void
}

const ReadOnlyCtx = createContext<ReadOnlyContextValue>({
  readonly: false,
  setReadonly: () => {},
})

const STORAGE_KEY = "readonly"

function readStored(): boolean {
  if (typeof window === "undefined") return false
  return localStorage.getItem(STORAGE_KEY) === "1"
}

export function ReadOnlyProvider({ children }: { children: React.ReactNode }) {
  // Start with `false` to match the server.
  // The useEffect below syncs from localStorage
  // after mount, which is the standard
  // localStorage-in-React pattern (avoids the
  // SSR hydration mismatch).
  const [readonly, setState] = useState(false)

  useEffect(() => {
    setState(readStored())
    // Listen for changes from other tabs.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setState(readStored())
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  const setReadonly = useCallback((next?: boolean) => {
    const target = next ?? !readStored()
    if (typeof window !== "undefined") {
      if (target) {
        localStorage.setItem(STORAGE_KEY, "1")
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    }
    setState(target)
  }, [])

  return (
    <ReadOnlyCtx.Provider value={{ readonly, setReadonly }}>
      {children}
    </ReadOnlyCtx.Provider>
  )
}

/**
 * Hook: read the current read-only state +
 * the toggle function. Use `readonly` to
 * conditionally render mutation buttons, and
 * `setReadonly` for the toggle UI.
 */
export function useReadOnly(): ReadOnlyContextValue {
  return useContext(ReadOnlyCtx)
}

/**
 * Banner that appears at the top of every
 * dashboard page when read-only is on.
 * Place once in the dashboard layout.
 */
export function ReadOnlyBanner() {
  const { readonly, setReadonly } = useReadOnly()
  if (!readonly) return null
  return (
    <div
      className="bg-amber-100 dark:bg-amber-900/40 border-b border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 px-4 py-2 flex items-center justify-between gap-2 text-sm"
      data-testid="readonly-banner"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>🔒</span>
        <span>
          <strong>Read-Only Modus aktiv</strong> — alle
          Schreibvorgänge sind gesperrt. Schreibgeschützt
          anzeigen ist sicher.
        </span>
      </div>
      <button
        onClick={() => setReadonly(false)}
        className="text-xs px-2 py-1 rounded bg-amber-200 dark:bg-amber-800 hover:bg-amber-300 dark:hover:bg-amber-700"
        data-testid="readonly-banner-deactivate"
      >
        Deaktivieren
      </button>
    </div>
  )
}

/**
 * Toggle button for the header. Shows the
 * current state and flips it on click. Always
 * visible — even without the banner — so
 * the user can opt INTO read-only mode.
 */
export function ReadOnlyToggle() {
  const { readonly, setReadonly } = useReadOnly()
  return (
    <button
      onClick={() => setReadonly(!readonly)}
      className={`text-xs px-2 py-1 rounded border flex items-center gap-1 ${
        readonly
          ? "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200"
          : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
      }`}
      data-testid="readonly-toggle"
      title={
        readonly
          ? "Read-Only Modus deaktivieren"
          : "Read-Only Modus aktivieren (Schreibvorgänge sperren)"
      }
    >
      <span aria-hidden>{readonly ? "🔒" : "🔓"}</span>
      <span>{readonly ? "Read-Only" : "Edit"}</span>
    </button>
  )
}
