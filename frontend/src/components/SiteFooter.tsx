/**
 * SiteFooter — minimal legal footer
 *
 * Per DSGVO + TMG § 5, every commercial web app reachable
 * from a German user base MUST have an Impressum and a
 * Datenschutzerklärung linked from EVERY page. The cleanest
 * way to guarantee that is to render the footer from the
 * root layout — that way the link is present even on
 * not-yet-fully-built pages (login, register, etc).
 *
 * The cookie-settings button dispatches the same
 * `open-cookie-settings` event that the Datenschutz page
 * uses, so the same CookieBanner dialog reopens. This
 * satisfies DSGVO Art. 7 (3) — easy withdrawal of consent.
 */
"use client"

import Link from "next/link"

import { useI18n } from "@/components/useI18n"

export function SiteFooter() {
  const { t } = useI18n()
  const year = new Date().getFullYear()

  return (
    <footer
      data-testid="site-footer"
      className="mt-auto border-t border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-4 text-sm text-gray-600 dark:text-gray-400 sm:flex-row sm:items-center sm:justify-between">
        <p>
          © {year} de-invoice. {t("legal.footer.rights")}.
        </p>
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Link
            href="/impressum"
            data-testid="footer-link-impressum"
            className="hover:text-gray-900 hover:underline dark:hover:text-gray-100"
          >
            {t("legal.footer.impressum")}
          </Link>
          <Link
            href="/datenschutz"
            data-testid="footer-link-datenschutz"
            className="hover:text-gray-900 hover:underline dark:hover:text-gray-100"
          >
            {t("legal.footer.datenschutz")}
          </Link>
          <button
            type="button"
            data-testid="footer-link-cookie-settings"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("open-cookie-settings"))
            }}
            className="hover:text-gray-900 hover:underline dark:hover:text-gray-100"
          >
            {t("legal.footer.cookieSettings")}
          </button>
        </nav>
      </div>
    </footer>
  )
}
