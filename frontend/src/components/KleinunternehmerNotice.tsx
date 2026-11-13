"use client"

/**
 * Tier 841 — the Kleinunternehmer's limits (§ 19 UStG): last year's Gesamtumsatz
 * above 25 000 €, this year's above (or near) 100 000 €, and what follows. The
 * backend (accounting/kleinunternehmer-status) says which; nothing shows for a
 * company that is no Kleinunternehmer or within the limits.
 *
 * Tier 845 — and the invoices issued without USt on a day the regulation does
 * not cover (its end set back over them): taxed supplies whose invoices state
 * no tax. Listed with links, also for a company that is no Kleinunternehmer
 * any more.
 */
import { useEffect, useState } from "react"
import Link from "next/link"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"
import { formatMoney as fmtMoney } from "@/lib/money"

type Hinweis = "vorjahrUeberschritten" | "laufendUeberschritten" | "laufendNahe" | "naechstesJahr" | "gruendungsjahr" | "ohneUmsatzsteuer"
interface KuStatus {
  kleinunternehmer: boolean
  jahr: number
  vorjahr: { jahr: number; umsatz: number; leer: boolean }
  laufend: { jahr: number; umsatz: number }
  grenzeVorjahr: number
  grenzeLaufend: number
  hinweise: Hinweis[]
  ohneUmsatzsteuer?: { anzahl: number; summe: number; rechnungen: Array<{ id: string; invoiceNumber: string; issueDate: string; total: number }> }
}

const deDay = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`

/** `refresh`: asked again when it changes (the settings, after the regulation's period is saved) */
export function KleinunternehmerNotice({ refresh = "" }: { refresh?: string | number }) {
  const { t } = useI18n()
  const [s, setS] = useState<KuStatus | null>(null)
  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    apiGet<KuStatus>(`/api/v1/accounting/kleinunternehmer-status?companyId=${companyId}`)
      .then(setS)
      .catch(() => setS(null))
  }, [refresh])
  if (!s?.hinweise?.length) return null
  const ohne = s.ohneUmsatzsteuer
  const limits = s.hinweise.filter((h) => h !== "ohneUmsatzsteuer")
  // the end of the regulation and an invoice without its tax are red, the rest a warning
  const ended = s.hinweise.includes("vorjahrUeberschritten") || s.hinweise.includes("laufendUeberschritten") || s.hinweise.includes("ohneUmsatzsteuer")
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
      {ohne && ohne.anzahl > 0 && (
        <div data-testid="kleinunternehmer-ohneUmsatzsteuer" className={limits.length ? "mb-3" : ""}>
          <p>{t("kleinunternehmer.ohneUmsatzsteuer", { anzahl: ohne.anzahl, summe: fmtMoney(ohne.summe) })}</p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {ohne.rechnungen.map((r) => (
              <li key={r.id}>
                <Link href={`/dashboard/invoices/${r.id}`} className="underline" data-testid="kleinunternehmer-ohne-link">
                  {r.invoiceNumber}
                </Link>{" "}
                ({deDay(r.issueDate)}, {fmtMoney(r.total)})
              </li>
            ))}
            {ohne.anzahl > ohne.rechnungen.length && (
              <li>{t("kleinunternehmer.ohneWeitere", { anzahl: ohne.anzahl - ohne.rechnungen.length })}</li>
            )}
          </ul>
        </div>
      )}
      {limits.length > 0 && (
        <>
          <ul className="list-disc pl-5 space-y-1">
            {limits.map((h) => (
              <li key={h} data-testid={`kleinunternehmer-${h}`}>{t(`kleinunternehmer.${h}`, p)}</li>
            ))}
          </ul>
          <div className="mt-2">
            {t("kleinunternehmer.action")}{" "}
            <Link href="/dashboard/settings" className="underline">{t("kleinunternehmer.settings")}</Link>
          </div>
        </>
      )}
    </div>
  )
}
