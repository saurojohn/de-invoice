/**
 * CookieBanner — what the application stores in the browser
 *
 * Tier 735: a notice, not a consent dialog. The application stores only what
 * it needs to work: the session cookie (httpOnly), the `x-user-id` /
 * `x-company-id` cookies, and in localStorage the signed-in user's and
 * company's ids, the e-mail address, the language and this notice's own
 * record. All of it is "unbedingt erforderlich" for a service the user asked
 * for (§ 25 Abs. 2 Nr. 2 TDDDG), so no consent is needed. The banner asked
 * for consent to "Analyse" and "Marketing" cookies that the application never
 * set — a consent request for nothing, and a hint at tracking that does not
 * exist. If an analytics tool is ever added, a consent dialog comes back
 * with it (and the tool loads only after a yes).
 *
 * Persistence: localStorage["cookie-consent"] = { necessary: true, savedAt }.
 * A record written by the old dialog (with analytics / marketing) counts as
 * seen, so nobody is asked again.
 *
 * The footer and the Datenschutz page reopen the notice through the
 * `open-cookie-settings` window event.
 */
"use client"

import { useEffect, useState } from "react"

import { useI18n } from "@/components/useI18n"

const STORAGE_KEY = "cookie-consent"
const EVENT_OPEN = "open-cookie-settings"

function noticeSeen(): boolean {
  if (typeof window === "undefined") return false
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && typeof parsed.savedAt === "string"
  } catch {
    return false
  }
}

export function CookieBanner() {
  const { t } = useI18n()
  // Don't render during SSR — the localStorage check would
  // throw and the page would hydrate with mismatched markup.
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setMounted(true)
    if (!noticeSeen()) setOpen(true)
  }, [])

  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener(EVENT_OPEN, handler)
    return () => window.removeEventListener(EVENT_OPEN, handler)
  }, [])

  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
    } catch { /* private window: the notice shows again next time */ }
    setOpen(false)
  }

  if (!mounted || !open) return null

  return (
    // Bottom-right floating card on >=md, full-width sheet on mobile. No
    // backdrop: the page stays usable while the notice is open.
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
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300" data-testid="cookie-banner-text">
          {t("legal.cookieBanner.intro")}
        </p>
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.cookieBanner.noTracking")}
        </p>

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

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-testid="cookie-btn-ok"
            onClick={dismiss}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            {t("legal.cookieBanner.ok")}
          </button>
        </div>
      </div>
    </div>
  )
}
