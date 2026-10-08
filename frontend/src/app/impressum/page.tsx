/**
 * Impressum (§ 5 DDG, § 18 Abs. 2 MStV).
 *
 * Tier 604: the provider's details are the operator's — the oldest company of
 * the installation — as entered in its company settings, read from the public
 * route GET /companies/imprint. Until then the page showed a made-up address
 * („Musterstraße 1“) and asked the operator, in a comment, to edit the source
 * before going live. Where the operator has entered nothing, the page says so.
 *
 * A client component because the i18n hook reads the language from
 * localStorage.
 */
"use client"

import { useEffect, useState } from "react"
import { useI18n } from "@/components/useI18n"
import { API_BASE } from "@/lib/api"

/** Tier 604: the operator's details, as entered in its company settings. */
type Imprint = {
  configured: boolean
  name: string | null; street: string | null; postalCode: string | null; city: string | null; country: string | null
  email: string | null; phone: string | null; website: string | null
  registerEntry: string | null; managingDirector: string | null; vatId: string | null
}

export default function ImpressumPage() {
  const { t } = useI18n()
  const [imprint, setImprint] = useState<Imprint | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    fetch(`${API_BASE}/api/v1/companies/imprint`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setImprint(d))
      .catch(() => setImprint(null))
      .finally(() => setLoaded(true))
  }, [])
  const missing = <span className="text-gray-400 dark:text-gray-500">—</span>
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
          <dd data-testid="impressum-name">{imprint?.name ?? missing}</dd>
          {imprint?.registerEntry && (<>
            <dt className="font-medium">{t("legal.impressum.register")}</dt>
            <dd data-testid="impressum-register">{imprint.registerEntry}</dd>
          </>)}
          {imprint?.managingDirector && (<>
            <dt className="font-medium">{t("legal.impressum.managingDirector")}</dt>
            <dd data-testid="impressum-director">{imprint.managingDirector}</dd>
          </>)}
        </dl>
        {loaded && !imprint?.configured && (
          <p className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" data-testid="impressum-not-configured">
            {t("legal.impressum.notConfigured")}
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.address")}
        </h2>
        <address className="mt-3 not-italic text-sm leading-6 text-gray-700 dark:text-gray-300">
          {imprint?.street ? (
            <span data-testid="impressum-address">
              {imprint.street}<br />
              {[imprint.postalCode, imprint.city].filter(Boolean).join(" ")}<br />
              {imprint.country === "DE" || !imprint.country ? "Deutschland" : imprint.country}
            </span>
          ) : missing}
        </address>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.contact")}
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-y-2 text-sm text-gray-700 dark:text-gray-300 sm:grid-cols-[max-content_1fr] sm:gap-x-6">
          <dt className="font-medium">{t("legal.impressum.phone")}</dt>
          <dd data-testid="impressum-phone">{imprint?.phone ?? missing}</dd>
          <dt className="font-medium">{t("legal.impressum.email")}</dt>
          <dd>
            {imprint?.email ? (
              <a href={`mailto:${imprint.email}`} className="break-all text-blue-600 hover:underline dark:text-blue-400" data-testid="impressum-email">
                {imprint.email}
              </a>
            ) : missing}
          </dd>
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.vatId")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          <span data-testid="impressum-vat">{imprint?.vatId ?? t("legal.impressum.vatIdValue")}</span>
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t("legal.impressum.responsible")}
        </h2>
        <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
          {imprint?.managingDirector ?? t("legal.impressum.responsibleName")}
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
