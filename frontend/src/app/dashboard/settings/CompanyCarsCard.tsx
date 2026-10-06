"use client"

/**
 * Tier 502 — company cars used privately (1 % rule). Each month a car is
 * there, 1 % of its gross list price (electric: 0,25 % / 0,5 %) is a
 * withdrawal in the EÜR / Anlage G, and 80 % of the 1 % value is an
 * unentgeltliche Wertabgabe at 19 % in the UStVA — computed by the backend
 * (company-car/private-use.ts). Not for a Kapitalgesellschaft (payroll).
 */
import { todayIso } from "@/lib/today"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api"

interface CompanyCar {
  id: string
  name: string
  listPrice: string
  method: "one_percent" | "electric_025" | "electric_05"
  fromDate: string
  untilDate: string | null
  // Tier 541: trips home – business
  commuteKm?: number | null
  commuteDays?: number | null
}

interface PrivateUse {
  income: number
  vatBase: number
  vat: number
  commute?: number
}

const eur = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" })
const day = (s: string) => new Date(s).toLocaleDateString("de-DE", { timeZone: "UTC" })

export default function CompanyCarsCard() {
  const { t } = useI18n()
  const year = new Date().getFullYear()
  const [cars, setCars] = useState<CompanyCar[]>([])
  const [use, setUse] = useState<PrivateUse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: "",
    listPrice: "",
    method: "one_percent" as CompanyCar["method"],
    fromDate: todayIso(),
    commuteKm: "",
    commuteDays: "",
  })

  const companyId = () => (typeof window !== "undefined" ? localStorage.getItem("companyId") : null)

  const load = async () => {
    try {
      const [list, summary] = await Promise.all([
        apiGet<CompanyCar[]>(`/api/v1/company-cars?companyId=${companyId()}`),
        apiGet<PrivateUse>(`/api/v1/company-cars/private-use?companyId=${companyId()}&year=${year}`),
      ])
      setCars(Array.isArray(list) ? list : [])
      setUse(summary)
    } catch (e: any) {
      setError(e?.message || t("companyCars.failed"))
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const add = async () => {
    const listPrice = Number(form.listPrice.replace(/\./g, "").replace(",", "."))
    if (!form.name.trim() || !listPrice || !form.fromDate) return
    setSaving(true)
    setError(null)
    try {
      const km = parseInt(form.commuteKm, 10)
      const days = parseInt(form.commuteDays, 10)
      await apiPost(`/api/v1/company-cars?companyId=${companyId()}`, {
        name: form.name,
        listPrice,
        method: form.method,
        fromDate: form.fromDate,
        ...(km > 0 ? { commuteKm: km, ...(days >= 0 ? { commuteDays: days } : {}) } : {}),
      })
      setForm((f) => ({ ...f, name: "", listPrice: "", commuteKm: "", commuteDays: "" }))
      await load()
    } catch (e: any) {
      setError(e?.message || t("companyCars.failed"))
    } finally {
      setSaving(false)
    }
  }

  const end = async (car: CompanyCar) => {
    const until = window.prompt(t("companyCars.endPrompt"), todayIso())
    if (!until) return
    setError(null)
    try {
      await apiPut(`/api/v1/company-cars/${car.id}?companyId=${companyId()}`, { untilDate: until })
      await load()
    } catch (e: any) {
      setError(e?.message || t("companyCars.failed"))
    }
  }

  const remove = async (car: CompanyCar) => {
    if (!window.confirm(t("companyCars.deleteConfirm"))) return
    setError(null)
    try {
      await apiDelete(`/api/v1/company-cars/${car.id}?companyId=${companyId()}`)
      await load()
    } catch (e: any) {
      setError(e?.message || t("companyCars.failed"))
    }
  }

  const methodLabel = (m: CompanyCar["method"]) =>
    m === "electric_025" ? t("companyCars.electric025") : m === "electric_05" ? t("companyCars.electric05") : t("companyCars.onePercent")

  return (
    <Card className="mt-6" data-testid="company-cars-card">
      <CardHeader>
        <CardTitle>{t("companyCars.title")}</CardTitle>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("companyCars.hint")}</p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-2 mb-4">
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("companyCars.name")}</span>
            <input
              className="border rounded px-2 py-1 w-36 bg-white dark:bg-gray-800"
              value={form.name}
              placeholder="M-AB 123"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              data-testid="company-car-name"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("companyCars.listPrice")}</span>
            <input
              className="border rounded px-2 py-1 w-32 bg-white dark:bg-gray-800"
              value={form.listPrice}
              placeholder="45.678,00"
              onChange={(e) => setForm({ ...form, listPrice: e.target.value })}
              data-testid="company-car-price"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("companyCars.method")}</span>
            <select
              className="border rounded px-2 py-1 bg-white dark:bg-gray-800"
              value={form.method}
              onChange={(e) => setForm({ ...form, method: e.target.value as CompanyCar["method"] })}
              data-testid="company-car-method"
            >
              <option value="one_percent">{t("companyCars.onePercent")}</option>
              <option value="electric_025">{t("companyCars.electric025")}</option>
              <option value="electric_05">{t("companyCars.electric05")}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("companyCars.from")}</span>
            <input
              type="date"
              className="border rounded px-2 py-1 bg-white dark:bg-gray-800"
              value={form.fromDate}
              onChange={(e) => setForm({ ...form, fromDate: e.target.value })}
              data-testid="company-car-from"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("companyCars.commuteKm")}</span>
            <input
              className="border rounded px-2 py-1 w-24 bg-white dark:bg-gray-800"
              value={form.commuteKm}
              inputMode="numeric"
              placeholder="—"
              title={t("companyCars.commuteHint")}
              onChange={(e) => setForm({ ...form, commuteKm: e.target.value })}
              data-testid="company-car-commute-km"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("companyCars.commuteDays")}</span>
            <input
              className="border rounded px-2 py-1 w-20 bg-white dark:bg-gray-800"
              value={form.commuteDays}
              inputMode="numeric"
              placeholder="15"
              title={t("companyCars.commuteHint")}
              onChange={(e) => setForm({ ...form, commuteDays: e.target.value })}
              data-testid="company-car-commute-days"
            />
          </label>
          <Button size="sm" onClick={add} disabled={saving} data-testid="company-car-add">
            {t("companyCars.add")}
          </Button>
        </div>
        {error && <div className="mb-3 text-sm text-red-700" data-testid="company-cars-error">{error}</div>}
        {cars.length === 0 ? (
          <p className="text-sm text-gray-500">{t("companyCars.none")}</p>
        ) : (
          <table className="w-full text-sm mb-3">
            <tbody>
              {cars.map((c) => (
                <tr key={c.id} className="border-b" data-testid="company-car-row">
                  <td className="py-2">{c.name}</td>
                  <td className="py-2">{eur(Number(c.listPrice))}</td>
                  <td className="py-2">{methodLabel(c.method)}</td>
                  <td className="py-2" data-testid="company-car-commute">
                    {c.commuteKm ? t("companyCars.commuteRow").replace("{km}", String(c.commuteKm)).replace("{days}", String(c.commuteDays ?? 15)) : ""}
                  </td>
                  <td className="py-2">
                    {day(c.fromDate)} – {c.untilDate ? day(c.untilDate) : t("companyCars.ongoing")}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {!c.untilDate && (
                      <Button size="sm" variant="outline" className="mr-2" onClick={() => end(c)}>
                        {t("companyCars.end")}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => remove(c)}>
                      {t("companyCars.delete")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {use && use.income > 0 && (
          <p className="text-sm text-gray-700 dark:text-gray-200" data-testid="company-cars-summary">
            {t("companyCars.summary")
              .replace("{year}", String(year))
              .replace("{income}", eur(use.income))
              .replace("{vat}", eur(use.vat))}
            {use.commute ? " " + t("companyCars.summaryCommute").replace("{commute}", eur(use.commute)) : ""}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
