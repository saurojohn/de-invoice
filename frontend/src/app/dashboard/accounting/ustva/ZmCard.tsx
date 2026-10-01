"use client"

/**
 * Tier 491 — Zusammenfassende Meldung (§ 18a UStG), a preview: per customer
 * USt-IdNr. and kind (L = innergemeinschaftliche Lieferung, S = sonstige
 * Leistung) the sum in full euros for a quarter, reconciled with UStVA
 * Kz 41 / Kz 21, and the CSV.
 */
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiFetch, apiGet } from "@/lib/api"

interface Zm {
  periodLabel: string
  rows: Array<{ land: string; ustIdNr: string; art: "L" | "S"; betrag: number }>
  summen: { L: number; S: number }
  abgleich: { kz41: number; kz21: number; stimmt: boolean }
  hinweise: string[]
  disclaimer: string
}

const eur = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" })

export default function ZmCard() {
  const { t } = useI18n()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1)
  const [zm, setZm] = useState<Zm | null>(null)
  const [error, setError] = useState<string | null>(null)

  const companyId = () => (typeof window !== "undefined" ? localStorage.getItem("companyId") : null)

  useEffect(() => {
    let alive = true
    setError(null)
    apiGet<Zm>(`/api/v1/ustva/zm?companyId=${companyId()}&year=${year}&quarter=${quarter}`)
      .then((d) => { if (alive) setZm(d) })
      .catch((e: any) => { if (alive) setError(e?.message || t("ustva.zmFailed")) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, quarter])

  const download = async () => {
    try {
      const res = await apiFetch(`/api/v1/ustva/zm.csv?companyId=${companyId()}&year=${year}&quarter=${quarter}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `ZM_${year}_Q${quarter}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError(e?.message || t("ustva.zmFailed"))
    }
  }

  return (
    <Card className="mt-6" data-testid="zm-card">
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
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              data-testid="zm-year"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("ustva.zmQuarter")}</span>
            <select
              className="border rounded px-2 py-1 bg-white dark:bg-gray-800"
              value={quarter}
              onChange={(e) => setQuarter(Number(e.target.value))}
              data-testid="zm-quarter"
            >
              {[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}
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
