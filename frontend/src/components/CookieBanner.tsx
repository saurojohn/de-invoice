/**
 * CookieBanner — DSGVO / TDDDG compliant consent UI
 *
 * Three categories (per the German TDDDG, "Telekommunikation-
 * Digitale-Dienste-Datenschutz-Gesetz", in force since 2024):
 *   - necessary:    always on, no toggle (authentication cookies,
 *                  CSRF tokens, load-balancer session affinity)
 *   - analytics:    opt-in (we currently set NO analytics cookies
 *                  even when consent is given — this is a hook
 *                  for a future integration; the UI must be
 *                  there for legal compliance)
 *   - marketing:    opt-in (same as analytics)
 *
 * Persistence: localStorage["cookie-consent"] = JSON of the
 * category map plus a "savedAt" timestamp. The DSGVO requires
 * the consent decision to be "demonstrable" — a server-side
 * audit log would be ideal for production, but localStorage
 * is the minimum-viable DSGVO-compliant storage in 2026
 * (the German courts have not yet ruled that localStorage
 * alone is insufficient, only that "implied consent" via
 * cookie wall is NOT sufficient — explicit accept/reject
 * buttons satisfy the requirement).
 *
 * The banner listens for the `open-cookie-settings` window
 * event so the Datenschutz page (and the footer) can reopen
 * the settings dialog at any time. This satisfies DSGVO Art.
 * 7 (3) — easy withdrawal of consent.
 */
"use client"

import { useEffect, useState } from "react"

import { useI18n } from "@/components/useI18n"

type Consent = {
  necessary: true
  analytics: boolean
  marketing: boolean
  savedAt: string
}

const STORAGE_KEY = "cookie-consent"
const EVENT_OPEN = "open-cookie-settings"

function loadConsent(): Consent | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    if (parsed.necessary !== true) return null
    if (typeof parsed.analytics !== "boolean") return null
    if (typeof parsed.marketing !== "boolean") return null
    if (typeof parsed.savedAt !== "string") return null
    return parsed as Consent
  } catch {
    return null
  }
}

function saveConsent(c: Consent) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
}

export function CookieBanner() {
  const { t } = useI18n()
  // Don't render during SSR — the localStorage check would
  // throw and the page would hydrate with mismatched markup.
  // Mounted is set in an effect to avoid the flicker.
  const [mounted, setMounted] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // form state for the settings dialog
  const [analytics, setAnalytics] = useState(false)
  const [marketing, setMarketing] = useState(false)

  // Initial mount: read existing consent (if any) and decide
  // whether to show the banner. The banner shows whenever
  // there's no consent record — even if the user has only
  // accepted the necessary category, the record exists.
  useEffect(() => {
    setMounted(true)
    const existing = loadConsent()
    if (!existing) {
      setShowSettings(true)
      // Reset form to "all off except necessary"
      setAnalytics(false)
      setMarketing(false)
    } else {
      setAnalytics(existing.analytics)
      setMarketing(existing.marketing)
    }
  }, [])

  // Listen for the open-settings event from the Datenschutz
  // page or footer. We always re-open on the event, regardless
  // of whether a consent is already saved — that's how
  // DSGVO-compliant "withdrawal of consent" works.
  useEffect(() => {
    const handler = () => {
      const existing = loadConsent()
      if (existing) {
        setAnalytics(existing.analytics)
        setMarketing(existing.marketing)
      }
      setShowSettings(true)
    }
    window.addEventListener(EVENT_OPEN, handler)
    return () => window.removeEventListener(EVENT_OPEN, handler)
  }, [])

  const acceptAll = () => {
    const c: Consent = {
      necessary: true,
      analytics: true,
      marketing: true,
      savedAt: new Date().toISOString(),
    }
    saveConsent(c)
    setShowSettings(false)
  }

  const rejectAll = () => {
    const c: Consent = {
      necessary: true,
      analytics: false,
      marketing: false,
      savedAt: new Date().toISOString(),
    }
    saveConsent(c)
    setShowSettings(false)
  }

  const saveCurrent = () => {
    const c: Consent = {
      necessary: true,
      analytics,
      marketing,
      savedAt: new Date().toISOString(),
    }
    saveConsent(c)
    setShowSettings(false)
  }

  // Don't render anything until the mount-effect has run —
  // otherwise we'd flash the banner on every page load even
  // after the user already consented.
  if (!mounted) return null
  if (!showSettings) return null

  return (
    // Bottom-right floating card on >=md, full-width sheet on mobile.
    // Role="dialog" + aria-modal + aria-labelledby is the minimum
    // for screen-reader compliance. Backdrop is intentionally absent
    // — DSGVO-compliant consent UIs must not block the user from
    // accessing the page (no "cookie wall" pattern).
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="cookie-banner-title"
      data-testid="cookie-banner"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800 md:inset-x-auto md:right-4 md:bottom-4 md:w-[28rem] md:rounded-lg md:border"
    >
      <div className="p-4 sm:p-5">
        <h2
          id="cookie-banner-title"
          className="text-base font-semibold text-gray-900 dark:text-gray-100"
        >
          {t("legal.cookieBanner.title")}
        </h2>
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.cookieBanner.intro")}
        </p>

        <div className="mt-4 space-y-2">
          <CategoryRow
            testid="cookie-cat-necessary"
            label={t("legal.cookieBanner.necessary.label")}
            description={t("legal.cookieBanner.necessary.description")}
            checked
            disabled
            onChange={() => {
              /* no-op: necessary is always on */
            }}
          />
          <CategoryRow
            testid="cookie-cat-analytics"
            label={t("legal.cookieBanner.analytics.label")}
            description={t("legal.cookieBanner.analytics.description")}
            checked={analytics}
            disabled={false}
            onChange={setAnalytics}
          />
          <CategoryRow
            testid="cookie-cat-marketing"
            label={t("legal.cookieBanner.marketing.label")}
            description={t("legal.cookieBanner.marketing.description")}
            checked={marketing}
            disabled={false}
            onChange={setMarketing}
          />
        </div>

        <p className="mt-4 text-xs text-gray-600 dark:text-gray-400">
          {t("legal.cookieBanner.policyNote")}
          <a
            href="/datenschutz"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {t("legal.cookieBanner.policyLink")}
          </a>
          .
        </p>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            data-testid="cookie-btn-reject"
            onClick={rejectAll}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            {t("legal.cookieBanner.rejectAll")}
          </button>
          <button
            type="button"
            data-testid="cookie-btn-save"
            onClick={saveCurrent}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            {t("legal.cookieBanner.saveSelection")}
          </button>
          <button
            type="button"
            data-testid="cookie-btn-accept"
            onClick={acceptAll}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t("legal.cookieBanner.acceptAll")}
          </button>
        </div>
      </div>
    </div>
  )
}

function CategoryRow(props: {
  testid: string
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      data-testid={props.testid}
      className="flex items-start gap-3 rounded border border-gray-200 p-2 dark:border-gray-700"
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      />
      <span className="flex-1">
        <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
          {props.label}
        </span>
        <span className="block text-xs text-gray-600 dark:text-gray-400">
          {props.description}
        </span>
      </span>
    </label>
  )
}
