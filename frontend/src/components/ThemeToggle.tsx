"use client"

import { useTheme, type Theme } from "./useTheme"
import { useI18n } from "./useI18n"

// Sun / moon / monitor icons inline (avoids
// pulling in an icon library for three glyphs).
// 16x16 viewBox matches the other inline icons
// in the app (LanguageSwitcher, etc.).
function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}
function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}
function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

// Three-state cycle: light → dark → system → light.
// Mirrors the OS / browser convention used by
// macOS / GNOME / KDE / Windows 11.
const ORDER: Theme[] = ["light", "dark", "system"]

/**
 * ThemeToggle — a small button that cycles
 * light/dark/system on click. The button text
 * shows the NEXT state on hover, and the current
 * icon (sun/moon/monitor) reflects the current
 * effective value. The button is "mounted-aware"
 * — it doesn't render any state-dependent text
 * before hydration, so the server-rendered HTML
 * matches the client and React doesn't complain
 * about a mismatch.
 */
export function ThemeToggle() {
  const { theme, setTheme, effective, mounted } = useTheme()
  const { t } = useI18n()
  const currentIdx = ORDER.indexOf(theme)
  const next = ORDER[(currentIdx + 1) % ORDER.length]
  const Icon =
    effective === "dark" ? MoonIcon : effective === "light" ? SunIcon : SystemIcon
  // Localized labels for the three theme states. Falls
  // back to the theme key itself if the i18n bundle is
  // missing the entry (defensive — same t() fallback
  // useI18n already does for any missing key).
  const labelOf = (th: Theme): string => {
    const k = `theme.${th}`
    const v = t(k)
    return v === k ? (th === "light" ? "Hell" : th === "dark" ? "Dunkel" : "System") : v
  }
  // Until mounted, render a placeholder button
  // with the same dimensions — prevents layout
  // shift on first paint.
  if (!mounted) {
    return (
      <button
        type="button"
        aria-label={t("theme.label") === "theme.label" ? "Theme" : t("theme.label")}
        className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-700 rounded text-gray-700 dark:text-gray-300 inline-flex items-center gap-1.5"
        style={{ minWidth: "70px" }}
      >
        <SystemIcon />
        <span className="text-xs">—</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`${t("theme.label")}: ${labelOf(theme)} → ${labelOf(next)}`}
      aria-label={`${t("theme.label")}: ${labelOf(theme)}`}
      className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-700 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 inline-flex items-center gap-1.5"
    >
      <Icon />
      <span className="text-xs">{labelOf(theme)}</span>
    </button>
  )
}
