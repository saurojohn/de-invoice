/**
 * Datenschutzerklärung page — DSGVO Art. 13 / § 13 TMG
 *
 * Static privacy policy. The "Controller" section links back
 * to the Impressum (DSGVO requires the controller identity
 * disclosed here). The 10-year retention period for invoices
 * is mandated by § 147 AO (Abgabenordnung) and the Cookie
 * section explicitly references the Tier 170c banner so users
 * can revoke their consent at any time.
 *
 * Why "use client": same as Impressum — useI18n() is a hook.
 */
"use client"

import Link from "next/link"

import { useI18n } from "@/components/useI18n"

export default function DatenschutzPage() {
  const { t } = useI18n()

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16 break-words">
      <h1
        className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100"
        data-testid="datenschutz-heading"
      >
        {t("legal.datenschutz.heading")}
      </h1>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        {t("legal.datenschutz.intro")}
      </p>

      <section className="mt-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.datenschutz.controller")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.controllerText")}{" "}
          {t("legal.datenschutz.seeImpressum")}
          <Link
            href="/impressum"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {t("legal.datenschutz.seeImpressumLink")}
          </Link>
          {t("legal.datenschutz.seeImpressumEnd")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.datenschutz.dataTypes")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.dataTypesText")}
        </p>
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.dataTypesList")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.datenschutz.purpose")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.purposeText")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.datenschutz.retention")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.retentionText")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.datenschutz.hosting")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.hostingText")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.datenschutz.transfer")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.transferText")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.datenschutz.cookies")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.cookiesText")}
        </p>
        <button
          type="button"
          // data-testid lets the e2e spec open the cookie
          // settings modal directly without guessing CSS
          data-testid="datenschutz-open-cookie-settings"
          onClick={() => {
            // The CookieBanner exposes a window event for
            // programmatic open. If the banner hasn't mounted
            // yet, the event is dropped silently — the user
            // can still scroll to the footer and click the
            // settings link there.
            window.dispatchEvent(new CustomEvent("open-cookie-settings"))
          }}
          className="mt-3 text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          {t("legal.datenschutz.openCookieSettings")}
        </button>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.datenschutz.rights")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.rightsText")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.datenschutz.changes")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.datenschutz.changesText")}
        </p>
      </section>
    </main>
  )
}
