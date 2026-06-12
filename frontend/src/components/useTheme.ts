"use client"

import { useEffect, useState, useCallback } from "react"

// Theme values. `system` follows the OS preference
// (prefers-color-scheme); the other two are
// explicit. The actual CSS class on <html> is
// `dark` (Tailwind v4's class strategy) or empty
// for light. We persist the user's choice in
// localStorage so the choice survives reloads and
// is applied BEFORE React hydrates (via a tiny
// pre-hydration script in layout.tsx).
export type Theme = "light" | "dark" | "system"

const STORAGE_KEY = "de-invoice.theme"

// Apply a Theme value to the DOM. Mutates the
// <html> element's className — the document
// element is the cheapest place to flip the
// dark-mode trigger so CSS sees it immediately.
function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return
  const root = document.documentElement
  // Strip both variants first so a previous value
  // doesn't stick.
  root.classList.remove("dark", "light")
  const effective =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme
  root.classList.add(effective)
  // Update the color-scheme meta hint. iOS Safari
  // uses this for the body / status bar background.
  root.style.colorScheme = effective
}

// Read the persisted value (with OS fallback) —
// used at hydration time on the client.
function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system"
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === "light" || raw === "dark" || raw === "system") return raw
  return "system"
}

/**
 * useTheme — the dark-mode hook. Returns the
 * current theme + a setter. The setter writes to
 * localStorage AND applies the class to <html>.
 * The hook also subscribes to the OS-level media
 * query so a user with theme="system" sees the
 * page flip when they change their macOS / Windows
 * appearance setting (without a reload).
 */
export function useTheme() {
  // The initial value is read AFTER mount, on the
  // client, to avoid hydration mismatch. The
  // pre-hydration script in layout.tsx sets the
  // <html> class correctly before React paints,
  // so the user never sees a flash.
  const [theme, setThemeState] = useState<Theme>("system")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const initial = readStoredTheme()
    setThemeState(initial)
    applyTheme(initial)
    setMounted(true)
    // Subscribe to OS-level changes when the user
    // is on "system". When the OS flips light↔dark,
    // we re-apply so the page follows.
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => {
      if (readStoredTheme() === "system") applyTheme("system")
    }
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // localStorage may throw in private-mode —
      // ignore, the theme still applies in-memory.
    }
    applyTheme(next)
  }, [])

  // Returns the "effective" theme (resolving
  // "system" to "light" or "dark"). Useful for the
  // toggle button which needs to show the right
  // icon regardless of system vs explicit.
  const effective: "light" | "dark" = mounted
    ? theme === "system"
      ? typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme
    : "light"

  return { theme, setTheme, effective, mounted }
}

/**
 * Read the pre-hydration theme synchronously. Used
 * by the inline script in layout.tsx to set the
 * <html> class BEFORE React mounts, eliminating
 * the white→dark flash on first load. This must
 * be a plain JS function (not React) so it can
 * run in a <script> tag.
 */
export const THEME_PREHYDRATION_SCRIPT = `
(function() {
  try {
    var raw = localStorage.getItem('${STORAGE_KEY}');
    var theme = (raw === 'light' || raw === 'dark' || raw === 'system') ? raw : 'system';
    var effective = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    var root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(effective);
    root.style.colorScheme = effective;
  } catch (e) {
    // localStorage can throw in private-mode or
    // when cookies are disabled. Fall back to
    // system preference.
    var effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.classList.add(effective);
  }
})();
`
