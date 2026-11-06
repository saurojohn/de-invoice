"use client"

/**
 * Tier 491 — Zusammenfassende Meldung (§ 18a UStG), a preview: per customer
 * USt-IdNr. and kind (L = innergemeinschaftliche Lieferung, S = sonstige
 * Leistung) the sum in full euros for a quarter, reconciled with UStVA
 * Kz 41 / Kz 21, and the CSV.
 */
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiFetch, apiGet } from "@/lib/api"
import { useYearField } from "@/lib/year-field"

interface Zm {
  periodLabel: string
  rows: Array<{ land: string; ustIdNr: string; art: "L" | "S"; betrag: number }>
  summen: { L: number; S: number }
  abgleich: { kz41: number; kz21: number; stimmt: boolean }
  hinweise: string[]
  disclaimer: string
}

const eur = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" })

/**
 * Tier 801: opens on the last ended quarter — the one to report — given by
 * the page (GET /ustva/deadlines), or on the quarter in the link from the
 * dashboard (?zmYear=&zmQuarter=). Nothing is fetched before that is known.
 */
export default function ZmCard({ initial }: { initial?: { year: number; quarter: number; month?: number | null } | null }) {
  const { t, locale } = useI18n()
  const [year, setYear] = useState(0)
  // a period the user picks is never replaced by the default arriving later
  const chosen = useRef(false)
  const yearField = useYearField(year, (y) => { chosen.current = true; setYear(y) })
  const [quarter, setQuarter] = useState(0)
  // Tier 807: a month of the quarter (0 = the whole quarter) — the ZM is
  // monthly above 50 000 € of goods supplies a quarter (§ 18a Abs. 1 UStG)
  const [month, setMonth] = useState(0)
  const [zm, setZm] = useState<Zm | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (chosen.current) return
    const q = new URLSearchParams(window.location.search)
    const y = Number(q.get("zmYear")), qu = Number(q.get("zmQuarter")), mo = Number(q.get("zmMonth"))
    if (Number.isInteger(y) && y >= 2010 && y <= 2100 && Number.isInteger(mo) && mo >= 1 && mo <= 12) {
      chosen.current = true
      setYear(y); setQuarter(Math.ceil(mo / 3)); setMonth(mo)
      return
    }
    if (Number.isInteger(y) && y >= 2010 && y <= 2100 && qu >= 1 && qu <= 4) {
      chosen.current = true
      setYear(y); setQuarter(qu)
      return
    }
    if (initial) {
      chosen.current = true
      setYear(initial.year); setQuarter(initial.quarter); setMonth(initial.month ?? 0)
      return
    }
    // the page could not say (request failed): the last ended quarter by the clock
    const timer = setTimeout(() => {
      if (chosen.current) return
      chosen.current = true
      const now = new Date()
      const cq = Math.floor(now.getMonth() / 3) + 1
      setYear(cq === 1 ? now.getFullYear() - 1 : now.getFullYear()); setQuarter(cq === 1 ? 4 : cq - 1)
    }, 5000)
    return () => clearTimeout(timer)
  }, [initial])

  const period = month ? `month=${month}` : `quarter=${quarter}`
  const companyId = () => (typeof window !== "undefined" ? localStorage.getItem("companyId") : null)

  useEffect(() => {
    if (!year || !quarter) return
    let alive = true
    setError(null)
    apiGet<Zm>(`/api/v1/ustva/zm?companyId=${companyId()}&year=${year}&${period}`)
      .then((d) => { if (alive) setZm(d) })
      .catch((e: any) => { if (alive) setError(e?.message || t("ustva.zmFailed")) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, quarter, month])

  const download = async () => {
    try {
      const res = await apiFetch(`/api/v1/ustva/zm.csv?companyId=${companyId()}&year=${year}&${period}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = month ? `ZM_${year}_M${String(month).padStart(2, "0")}.csv` : `ZM_${year}_Q${quarter}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError(e?.message || t("ustva.zmFailed"))
    }
  }

  return (
    <Card className="mt-6" id="zm" data-testid="zm-card">
      <CardHeader>
        <CardTitle>{t("ustva.zmTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-2 mb-4">
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("ustva.taxYear")}</span>
            <input
              type="number"
              className="border rounded px-2 py-1 w-24 bg-white dark:bg-gray-800"
              {...yearField}
              data-testid="zm-year"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("ustva.zmQuarter")}</span>
            <select
              className="border rounded px-2 py-1 bg-white dark:bg-gray-800"
              value={quarter || ""}
              onChange={(e) => { chosen.current = true; setQuarter(Number(e.target.value)); setMonth(0) }}
              data-testid="zm-quarter"
            >
              {[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("ustva.zmMonth")}</span>
            <select
              className="border rounded px-2 py-1 bg-white dark:bg-gray-800"
              value={month}
              onChange={(e) => { chosen.current = true; setMonth(Number(e.target.value)) }}
              data-testid="zm-month"
            >
              <option value={0}>{t("ustva.zmWholeQuarter")}</option>
              {quarter > 0 && [1, 2, 3].map((i) => {
                const m = (quarter - 1) * 3 + i
                return <option key={m} value={m}>{new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString(locale === "en" ? "en-GB" : locale === "zh" ? "zh-CN" : "de-DE", { month: "long", timeZone: "UTC" })}</option>
              })}
            </select>
          </label>
          <Button size="sm" variant="outline" onClick={download} data-testid="zm-csv">CSV</Button>
        </div>
        {error && <div className="mb-3 text-sm text-red-700">{error}</div>}
        {zm && (
          <>
            {zm.rows.length === 0 ? (
              <p className="text-sm text-gray-500" data-testid="zm-empty">{t("ustva.zmEmpty")}</p>
            ) : (
              <table className="w-full text-sm mb-3">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-1">{t("ustva.zmCountry")}</th>
                    <th className="text-left py-1">{t("ustva.zmVatId")}</th>
                    <th className="text-left py-1">{t("ustva.zmKind")}</th>
                    <th className="text-right py-1">{t("ustva.zmAmount")}</th>
                  </tr>
                </thead>
                <tbody>
                  {zm.rows.map((r) => (
                    <tr key={`${r.land}${r.ustIdNr}${r.art}`} className="border-b" data-testid="zm-row">
                      <td className="py-1">{r.land}</td>
                      <td className="py-1">{r.ustIdNr || "—"}</td>
                      <td className="py-1">{r.art}</td>
                      <td className="py-1 text-right">{eur(r.betrag)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p
              className={`text-sm ${zm.abgleich.stimmt ? "text-emerald-700" : "text-amber-700"}`}
              data-testid="zm-abgleich"
            >
              {zm.abgleich.stimmt ? "✓" : "⚠"} {t("ustva.zmReconcile")} Kz 41 {eur(zm.abgleich.kz41)} · Kz 21 {eur(zm.abgleich.kz21)}
            </p>
            {zm.hinweise.map((h) => <p key={h} className="text-sm text-amber-700">{h}</p>)}
            <p className="mt-2 text-xs text-gray-500">{zm.disclaimer}</p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
