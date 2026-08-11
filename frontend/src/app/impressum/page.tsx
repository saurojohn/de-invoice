/**
 * Impressum page — DSGVO / TMG § 5 / MStV § 18 compliance
 *
 * Static legal notice. The provider details are intentionally
 * placeholder ("auf Anfrage", "wird auf Anfrage mitgeteilt") —
 * the real operator MUST fill these in via a deployment-time
 * template (.env → Company settings) before going public. The
 * DSGVO/§ 5 TMG compliance check is satisfied as long as:
 *   1. The page is reachable from the footer (Tier 170d)
 *   2. The provider name + contact email are filled in
 *   3. The VAT ID / responsible person fields exist
 *
 * Why client component, not server:
 *   The i18n hook (`useI18n`) is a client hook (reads
 *   localStorage on mount to pick the locale). Server components
 *   can't call useState/useEffect, so we mark it "use client".
 *   The page is small enough that the SSR-vs-CSR difference
 *   doesn't matter for SEO (legal pages don't need crawling).
 */
"use client"

import { useI18n } from "@/components/useI18n"

export default function ImpressumPage() {
  const { t } = useI18n()

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16 break-words">
      <h1
        className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100"
        data-testid="impressum-heading"
      >
        {t("legal.impressum.heading")}
      </h1>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        {t("legal.impressum.intro")}
      </p>

      <section className="mt-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.company")}
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-y-2 text-sm text-gray-700 dark:text-gray-300 sm:grid-cols-[max-content_1fr] sm:gap-x-6">
          <dt className="font-medium">{t("legal.impressum.companyName")}</dt>
          <dd>{t("legal.impressum.companyName") === "Firmenname" ? "—" : t("legal.impressum.companyName")}</dd>
          <dt className="font-medium">{t("legal.impressum.companyForm")}</dt>
          <dd>{t("legal.impressum.companyForm")}</dd>
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.address")}
        </h2>
        <address className="mt-3 not-italic text-sm leading-6 text-gray-700 dark:text-gray-300">
          {/* Placeholder address — operator MUST replace before going public. */}
          Musterstraße 1<br />
          12345 Musterstadt<br />
          Deutschland
        </address>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.contact")}
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-y-2 text-sm text-gray-700 dark:text-gray-300 sm:grid-cols-[max-content_1fr] sm:gap-x-6">
          <dt className="font-medium">{t("legal.impressum.phone")}</dt>
          <dd>+49 (0) 000 000000</dd>
          <dt className="font-medium">{t("legal.impressum.email")}</dt>
          <dd>
            <a
              href="mailto:info@example.com"
              className="break-all text-blue-600 hover:underline dark:text-blue-400"
            >
              info@example.com
            </a>
          </dd>
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.vatId")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.impressum.vatIdValue")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.responsible")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.impressum.responsibleName")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.dispute")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.impressum.disputeText")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.liability")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.impressum.liabilityText")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.links")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.impressum.linksText")}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.copyright")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {t("legal.impressum.copyrightText")}
        </p>
      </section>
    </main>
  )
}
