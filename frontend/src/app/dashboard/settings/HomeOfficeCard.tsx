"use client"

/**
 * Tier 504 — the home office of a sole trader / partner, per year: the
 * Tagespauschale (6 € a day, at most 210 days) or the Jahrespauschale
 * (1 260 €, a twelfth less per month without). The backend books it as a
 * Betriebsausgabe in the EÜR / Anlage S / G (home-office/home-office.ts).
 */
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiDelete, apiGet, apiPut } from "@/lib/api"

interface HomeOffice {
  method: "tagespauschale" | "jahrespauschale"
  days: number | null
  months: number | null
  amount: number
}

const eur = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" })

export default function HomeOfficeCard() {
  const { t } = useI18n()
  const [year, setYear] = useState(new Date().getFullYear())
  const [saved, setSaved] = useState<HomeOffice | null>(null)
  const [method, setMethod] = useState<HomeOffice["method"]>("tagespauschale")
  const [days, setDays] = useState("")
  const [months, setMonths] = useState("12")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const companyId = () => (typeof window !== "undefined" ? localStorage.getItem("companyId") : null)

  const load = async (y: number) => {
    setError(null)
    try {
      const row = await apiGet<HomeOffice | { method: null }>(`/api/v1/home-office/${y}?companyId=${companyId()}`)
      setSaved(row?.method ? (row as HomeOffice) : null)
      if (row?.method) {
        setMethod(row.method)
        setDays(row.days != null ? String(row.days) : "")
        setMonths(row.months != null ? String(row.months) : "12")
      }
    } catch (e: any) {
      setSaved(null)
      setError(e?.message || t("homeOffice.failed"))
    }
  }
  useEffect(() => {
    load(year)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const body = method === "tagespauschale" ? { method, days: Number(days) } : { method, months: Number(months) }
      const row = await apiPut<HomeOffice>(`/api/v1/home-office/${year}?companyId=${companyId()}`, body)
      setSaved(row)
    } catch (e: any) {
      setError(e?.message || t("homeOffice.failed"))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setError(null)
    try {
      await apiDelete(`/api/v1/home-office/${year}?companyId=${companyId()}`)
      setSaved(null)
      setDays("")
    } catch (e: any) {
      setError(e?.message || t("homeOffice.failed"))
    }
  }

  return (
    <Card className="mt-6" data-testid="home-office-card">
      <CardHeader>
        <CardTitle>{t("homeOffice.title")}</CardTitle>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("homeOffice.hint")}</p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("homeOffice.year")}</span>
            <input
              type="number"
              className="border rounded px-2 py-1 w-24 bg-white dark:bg-gray-800"
              value={year}
              min={2023}
              onChange={(e) => setYear(Number(e.target.value))}
              data-testid="home-office-year"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("homeOffice.method")}</span>
            <select
              className="border rounded px-2 py-1 bg-white dark:bg-gray-800"
              value={method}
              onChange={(e) => setMethod(e.target.value as HomeOffice["method"])}
              data-testid="home-office-method"
            >
              <option value="tagespauschale">{t("homeOffice.tagespauschale")}</option>
              <option value="jahrespauschale">{t("homeOffice.jahrespauschale")}</option>
            </select>
          </label>
          {method === "tagespauschale" ? (
            <label className="text-sm">
              <span className="block text-gray-600 dark:text-gray-300">{t("homeOffice.days")}</span>
              <input
                type="number"
                className="border rounded px-2 py-1 w-24 bg-white dark:bg-gray-800"
                value={days}
                min={0}
                max={366}
                onChange={(e) => setDays(e.target.value)}
                data-testid="home-office-days"
              />
            </label>
          ) : (
            <label className="text-sm">
              <span className="block text-gray-600 dark:text-gray-300">{t("homeOffice.months")}</span>
              <input
                type="number"
                className="border rounded px-2 py-1 w-20 bg-white dark:bg-gray-800"
                value={months}
                min={1}
                max={12}
                onChange={(e) => setMonths(e.target.value)}
                data-testid="home-office-months"
              />
            </label>
          )}
          <Button size="sm" onClick={save} disabled={saving} data-testid="home-office-save">
            {t("homeOffice.save")}
          </Button>
          {saved && (
            <Button size="sm" variant="outline" onClick={remove} data-testid="home-office-delete">
              {t("homeOffice.delete")}
            </Button>
          )}
        </div>
        {error && <div className="mb-2 text-sm text-red-700">{error}</div>}
        {saved ? (
          <p className="text-sm text-gray-700 dark:text-gray-200" data-testid="home-office-amount">
            {t("homeOffice.amount").replace("{year}", String(year)).replace("{amount}", eur(Number(saved.amount)))}
          </p>
        ) : (
          <p className="text-sm text-gray-500">{t("homeOffice.none")}</p>
        )}
      </CardContent>
    </Card>
  )
}
