"use client"

/**
 * Tier 611 — time tracking (Zeiterfassung).
 *
 * Hours worked are written down per day, with or without a customer and an
 * hourly rate. The open, billable hours of a customer become the lines of an
 * invoice draft with one click; from then on an entry is "billed" and cannot
 * be changed — until the draft is deleted or the invoice cancelled, which
 * opens it again.
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "@/lib/api"
import { todayIso } from "@/lib/today"

interface TimeEntry {
  id: string
  date: string
  minutes: number
  description: string
  customerId: string | null
  customer: { id: string; name: string } | null
  hourlyRate: string | number | null
  billable: boolean
  invoiceId: string | null
  invoice: { id: string; invoiceNumber: string; status: string } | null
}
interface Summary {
  minutes: number
  openBillableMinutes: number
  openAmount: number
}
interface CustomerOption {
  id: string
  name: string
}

/** "1:30", "1,5", "1.5" or "90m" → minutes; null when it is none of these */
function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  let m = /^(\d{1,3}):([0-5]\d)$/.exec(s)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  m = /^(\d{1,4})\s*m(in)?$/.exec(s)
  if (m) return Number(m[1])
  m = /^(\d{1,3})(?:[.,](\d{1,2}))?\s*h?$/.exec(s)
  if (m) return Math.round(Number(`${m[1]}.${m[2] || "0"}`) * 60)
  return null
}
// as on the invoice line: hours with two decimals (50 min → 0,83 Std) times the rate
const lineAmount = (minutes: number, rate: number) => Math.round((Math.round((minutes / 60) * 100) / 100) * rate * 100) / 100
const hhmm = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
const day = (iso: string) => String(iso).slice(0, 10).split("-").reverse().join(".")

const BLANK = { date: "", customerId: "", duration: "", description: "", hourlyRate: "", billable: true }

export default function TimeTrackingPage() {
  const router = useRouter()
  const { t, locale } = useI18n()
  const toast = useToast()
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [summary, setSummary] = useState<Summary>({ minutes: 0, openBillableMinutes: 0, openAmount: 0 })
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ ...BLANK })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [filterCustomer, setFilterCustomer] = useState("")
  const [filterState, setFilterState] = useState<"open" | "billed" | "all">("open")

  const money = useMemo(
    () => new Intl.NumberFormat(locale === "en" ? "en-GB" : locale === "zh" ? "zh-CN" : "de-DE", { style: "currency", currency: "EUR" }),
    [locale],
  )

  const load = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    try {
      const qs = new URLSearchParams({ companyId, state: filterState })
      if (filterCustomer) qs.set("customerId", filterCustomer)
      const r = await apiGet<{ data: TimeEntry[]; summary: Summary }>(`/api/v1/time-entries?${qs.toString()}`)
      setEntries(r.data)
      setSummary(r.summary)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("time.loadFailed"))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCustomer, filterState])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setForm((f) => ({ ...f, date: f.date || todayIso() }))
    apiGet<{ data: CustomerOption[] }>(`/api/v1/customers?companyId=${companyId}&pageSize=500`)
      .then((r) => setCustomers((r.data || []).map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCustomers([]))
  }, [])

  const minutes = parseDuration(form.duration)
  const rate = form.hourlyRate.trim() === "" ? null : Number(form.hourlyRate.replace(",", "."))
  const formValid =
    !!form.date && minutes !== null && minutes > 0 && minutes <= 24 * 60 && form.description.trim().length > 0 && (rate === null || (Number.isFinite(rate) && rate >= 0))

  const save = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !formValid || minutes === null) return
    setBusy(true)
    try {
      const body = {
        date: form.date,
        minutes,
        description: form.description.trim(),
        customerId: form.customerId || null,
        hourlyRate: rate,
        billable: form.billable,
      }
      if (editingId) await apiPut(`/api/v1/time-entries/${editingId}?companyId=${companyId}`, body)
      else await apiPost(`/api/v1/time-entries?companyId=${companyId}`, body)
      // the next entry is usually the same day, customer and rate
      setForm({ ...BLANK, date: form.date, customerId: form.customerId, hourlyRate: form.hourlyRate, billable: form.billable })
      setEditingId(null)
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("time.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  const edit = (e: TimeEntry) => {
    setEditingId(e.id)
    setForm({
      date: String(e.date).slice(0, 10),
      customerId: e.customerId || "",
      duration: hhmm(e.minutes),
      description: e.description,
      hourlyRate: e.hourlyRate === null ? "" : String(Number(e.hourlyRate)),
      billable: e.billable,
    })
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const remove = async (e: TimeEntry) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !confirm(t("time.confirmDelete"))) return
    try {
      await apiDelete(`/api/v1/time-entries/${e.id}?companyId=${companyId}`)
      if (editingId === e.id) {
        setEditingId(null)
        setForm({ ...BLANK, date: todayIso() })
      }
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("time.saveFailed"))
    }
  }

  // what "bill" would take: the open, billable, priced entries of the chosen customer
  const billable = entries.filter((e) => !e.invoiceId && e.billable && e.customerId && e.customerId === filterCustomer && e.hourlyRate !== null)
  const billableAmount = billable.reduce((s, e) => s + lineAmount(e.minutes, Number(e.hourlyRate)), 0)

  const bill = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !filterCustomer || billable.length === 0) return
    if (!confirm(t("time.confirmBill", { count: billable.length }))) return
    setBusy(true)
    try {
      const r = await apiPost<{ invoiceId: string }>(`/api/v1/time-entries/bill?companyId=${companyId}`, {
        customerId: filterCustomer,
        entryIds: billable.map((e) => e.id),
      })
      router.push(`/dashboard/invoices/${r.invoiceId}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("time.billFailed"))
      setBusy(false)
    }
  }

  const stateOf = (e: TimeEntry) => (e.invoiceId ? "billed" : e.billable ? "open" : "notBillable")
  const amountOf = (e: TimeEntry) => (e.hourlyRate === null ? null : lineAmount(e.minutes, Number(e.hourlyRate)))

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400">{t("time.title")}</h1>
          <div className="flex flex-wrap gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" size="sm" onClick={() => router.push("/dashboard")}>
              {t("common.back")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8 max-w-5xl space-y-6">
        <Card data-testid="time-form">
          <CardHeader>
            <CardTitle>{editingId ? t("time.editEntry") : t("time.newEntry")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-4">
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.date")}</span>
                <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} data-testid="time-date" />
              </label>
              <label className="block text-sm md:col-span-2">
                <span className="block font-medium mb-1">{t("time.customer")}</span>
                <select
                  className="w-full h-10 border rounded-md px-3 bg-white dark:bg-gray-800"
                  value={form.customerId}
                  onChange={(e) => setForm({ ...form, customerId: e.target.value })}
                  data-testid="time-customer"
                >
                  <option value="">{t("time.noCustomer")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.duration")}</span>
                <Input
                  value={form.duration}
                  onChange={(e) => setForm({ ...form, duration: e.target.value })}
                  placeholder="1:30"
                  data-testid="time-duration"
                  aria-invalid={form.duration !== "" && minutes === null}
                />
                <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1" data-testid="time-duration-hint">
                  {form.duration !== "" && (minutes === null || minutes <= 0 || minutes > 24 * 60) ? t("time.durationInvalid") : t("time.durationHint")}
                </span>
              </label>
              <label className="block text-sm md:col-span-2">
                <span className="block font-medium mb-1">{t("time.description")}</span>
                <Input
                  value={form.description}
                  maxLength={500}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  data-testid="time-description"
                />
              </label>
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.hourlyRate")}</span>
                <Input
                  inputMode="decimal"
                  value={form.hourlyRate}
                  onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                  placeholder="90"
                  data-testid="time-rate"
                />
              </label>
              <label className="flex items-center gap-2 text-sm md:mt-7">
                <input
                  type="checkbox"
                  checked={form.billable}
                  onChange={(e) => setForm({ ...form, billable: e.target.checked })}
                  data-testid="time-billable"
                />
                {t("time.billable")}
              </label>
            </div>
            <div className="flex flex-wrap gap-2 mt-4">
              <Button onClick={save} disabled={!formValid || busy} data-testid="time-save">
                {editingId ? t("time.saveChanges") : t("time.add")}
              </Button>
              {editingId && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingId(null)
                    setForm({ ...BLANK, date: todayIso() })
                  }}
                >
                  {t("common.cancel")}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-wrap gap-3 items-end">
              <label className="block text-sm">
                <span className="block font-medium mb-1">{t("time.customer")}</span>
                <select
                  className="h-10 border rounded-md px-3 bg-white dark:bg-gray-800 max-w-full"
                  value={filterCustomer}
                  onChange={(e) => setFilterCustomer(e.target.value)}
                  data-testid="time-filter-customer"
                >
                  <option value="">{t("time.allCustomers")}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2" role="group" aria-label={t("time.state")}>
                {(["open", "billed", "all"] as const).map((s) => (
                  <Button key={s} size="sm" variant={filterState === s ? "default" : "outline"} onClick={() => setFilterState(s)} data-testid={`time-state-${s}`}>
                    {t(`time.state_${s}`)}
                  </Button>
                ))}
              </div>
              <div className="ml-auto text-sm text-right" data-testid="time-summary">
                <div>
                  {t("time.sumHours")}: <strong data-testid="time-sum-hours">{hhmm(summary.minutes)}</strong>
                </div>
                <div>
                  {t("time.sumOpen")}: <strong data-testid="time-sum-open">{hhmm(summary.openBillableMinutes)}</strong> ·{" "}
                  <strong data-testid="time-sum-amount">{money.format(summary.openAmount)}</strong>
                </div>
              </div>
            </div>
            {filterCustomer && filterState !== "billed" && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button onClick={bill} disabled={busy || billable.length === 0} data-testid="time-bill">
                  {t("time.bill", { count: billable.length, amount: money.format(billableAmount) })}
                </Button>
                <span className="text-xs text-gray-500 dark:text-gray-400">{t("time.billHint")}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <p className="text-center text-gray-500 dark:text-gray-400 py-8">{t("common.loading")}</p>
            ) : entries.length === 0 ? (
              <p className="text-center text-gray-500 dark:text-gray-400 py-8" data-testid="time-empty">
                {t("time.empty")}
              </p>
            ) : (
              <table className="w-full text-sm" data-testid="time-table">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-3">{t("time.date")}</th>
                    <th className="py-2 pr-3">{t("time.customer")}</th>
                    <th className="py-2 pr-3">{t("time.description")}</th>
                    <th className="py-2 pr-3 text-right">{t("time.duration")}</th>
                    <th className="py-2 pr-3 text-right">{t("time.amount")}</th>
                    <th className="py-2 pr-3">{t("time.state")}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const amount = amountOf(e)
                    const state = stateOf(e)
                    return (
                      <tr key={e.id} className="border-b last:border-0" data-testid="time-row">
                        <td className="py-2 pr-3 whitespace-nowrap">{day(e.date)}</td>
                        <td className="py-2 pr-3">{e.customer?.name || "—"}</td>
                        <td className="py-2 pr-3">{e.description}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{hhmm(e.minutes)}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{amount === null ? "—" : money.format(amount)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap" data-testid="time-row-state">
                          {state === "billed" && e.invoice ? (
                            <a href={`/dashboard/invoices/${e.invoice.id}`} className="underline text-green-700 dark:text-green-300">
                              {e.invoice.invoiceNumber}
                            </a>
                          ) : (
                            <span className={state === "open" ? "text-blue-700 dark:text-blue-300" : "text-gray-500 dark:text-gray-400"}>
                              {t(`time.state_${state}`)}
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          {!e.invoiceId && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => edit(e)} data-testid="time-row-edit">
                                {t("common.edit")}
                              </Button>
                              <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => remove(e)} data-testid="time-row-delete">
                                {t("common.delete")}
                              </Button>
                            </>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
