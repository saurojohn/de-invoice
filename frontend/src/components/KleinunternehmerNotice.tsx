"use client"

/**
 * Tier 841 — the Kleinunternehmer's limits (§ 19 UStG): last year's Gesamtumsatz
 * above 25 000 €, this year's above (or near) 100 000 €, and what follows. The
 * backend (accounting/kleinunternehmer-status) says which; nothing shows for a
 * company that is no Kleinunternehmer or within the limits.
 */
import { useEffect, useState } from "react"
import Link from "next/link"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"
import { formatMoney as fmtMoney } from "@/lib/money"

type Hinweis = "vorjahrUeberschritten" | "laufendUeberschritten" | "laufendNahe" | "naechstesJahr" | "gruendungsjahr"
interface KuStatus {
  kleinunternehmer: boolean
  jahr: number
  vorjahr: { jahr: number; umsatz: number; leer: boolean }
  laufend: { jahr: number; umsatz: number }
  grenzeVorjahr: number
  grenzeLaufend: number
  hinweise: Hinweis[]
}

export function KleinunternehmerNotice() {
  const { t } = useI18n()
  const [s, setS] = useState<KuStatus | null>(null)
  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    apiGet<KuStatus>(`/api/v1/accounting/kleinunternehmer-status?companyId=${companyId}`)
      .then(setS)
      .catch(() => setS(null))
  }, [])
  if (!s?.kleinunternehmer || !s.hinweise?.length) return null
  // the end of the regulation is red, the rest a warning
  const ended = s.hinweise.includes("vorjahrUeberschritten") || s.hinweise.includes("laufendUeberschritten")
  const p = {
    jahr: s.jahr,
    vorjahr: s.vorjahr.jahr,
    naechstes: s.jahr + 1,
    umsatzVorjahr: fmtMoney(s.vorjahr.umsatz),
    umsatz: fmtMoney(s.laufend.umsatz),
    grenzeVorjahr: fmtMoney(s.grenzeVorjahr),
    grenzeLaufend: fmtMoney(s.grenzeLaufend),
  }
  return (
    <div
      data-testid="kleinunternehmer-notice"
      data-ended={ended ? "true" : "false"}
      role="alert"
      className={`mb-6 rounded-lg border p-4 text-sm ${
        ended
          ? "border-red-300 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-900/20 dark:text-red-100"
          : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-100"
      }`}
    >
      <div className="font-semibold mb-1">{t("kleinunternehmer.title")}</div>
      <ul className="list-disc pl-5 space-y-1">
        {s.hinweise.map((h) => (
          <li key={h} data-testid={`kleinunternehmer-${h}`}>{t(`kleinunternehmer.${h}`, p)}</li>
        ))}
      </ul>
      <div className="mt-2">
        {t("kleinunternehmer.action")}{" "}
        <Link href="/dashboard/settings" className="underline">{t("kleinunternehmer.settings")}</Link>
      </div>
    </div>
  )
}
