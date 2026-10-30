"use client"

/**
 * Tier 744 — on the dashboard of a tax auditor: what this access is, and when
 * it ends. Nothing is shown to any other role.
 */
import { useEffect, useState } from "react"
import Link from "next/link"

import { apiGet } from "@/lib/api"
import { useI18n } from "@/components/useI18n"

export function AuditorAccessNotice() {
  const { t, getDateLocale } = useI18n()
  const [until, setUntil] = useState<string | null>(null)

  useEffect(() => {
    apiGet<{ role?: string; accessUntil?: string | null }>("/api/v1/auth/me")
      .then((me) => { if (me?.role === "auditor" && me.accessUntil) setUntil(me.accessUntil) })
      .catch(() => undefined)
  }, [])

  if (!until) return null
  return (
    <div
      role="status"
      data-testid="auditor-access-notice"
      className="mb-4 rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-100"
    >
      <p className="font-medium">{t("auditor.title")}</p>
      <p className="mt-1">{t("auditor.text", { date: new Date(until).toLocaleDateString(getDateLocale(), { timeZone: "UTC" }) })}</p>
      <Link href="/dashboard/audit" className="mt-1 inline-block underline">{t("auditor.archives")}</Link>
    </div>
  )
}
