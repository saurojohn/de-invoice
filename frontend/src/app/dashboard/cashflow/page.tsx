"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"
import { CashflowChart } from "@/components/CashflowChart"

interface CashflowMonth {
  month: string
  label: string
  incoming: number
  outgoing: number
  net: number
  cumulative: number
  isDry: boolean
}

interface CashflowResponse {
  companyId: string
  startingBalance: number
  months: CashflowMonth[]
  summary: {
    totalIncoming: number
    totalOutgoing: number
    totalNet: number
    endBalance: number
    firstDryMonth: string | null
  }
  counts: {
    openInvoices: number
    openExpenses: number
    recurringTemplates: number
  }
  generatedAt: string
}

export default function CashflowPage() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  // Tier 73: useToast/useI18n return fresh objects
  // every render — capture in refs so useCallback deps
  // stay stable. (audit-trail + security pattern.)
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [data, setData] = useState<CashflowResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [startingBalance, setStartingBalance] = useState<string>("0")
  const [months, setMonths] = useState<string>("12")
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(
    async (sb?: number, m?: number) => {
      setLoading(true)
      try {
        // The endpoint requires companyId as a query
        // param (HeaderAuthGuard reads it from the
        // header, but the controller signature needs
        // the explicit param). Pull it from localStorage
        // — same source the auth guard uses.
        const companyId =
          typeof window !== "undefined"
            ? localStorage.getItem("companyId")
            : null
        const params = new URLSearchParams()
        if (companyId) params.set("companyId", companyId)
        if (typeof sb === "number") {
          params.set("startingBalance", String(sb))
        }
        if (typeof m === "number") {
          params.set("months", String(m))
        }
        const qs = params.toString()
        const result = await apiGet<CashflowResponse>(
          `/api/v1/reports/cashflow${qs ? `?${qs}` : ""}`,
        )
        setData(result)
      } catch (e: any) {
        const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
        toastRef.current.error(msg)
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    load(0, 12)
  }, [load, router])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Accept German decimal comma for the balance
    // input — same convention as everywhere else in
    // the app (steuerberater types "12.345,67").
    const sb = Number((startingBalance || "0").replace(/\./g, "").replace(",", "."))
    const m = parseInt(months || "12", 10)
    if (!Number.isFinite(sb) || sb < 0) {
      toastRef.current.error("Anfangsbestand ungültig")
      return
    }
    if (!Number.isFinite(m) || m < 1 || m > 36) {
      toastRef.current.error("Monatsanzahl muss zwischen 1 und 36 liegen")
      return
    }
    setSubmitting(true)
    await load(sb, m)
    setSubmitting(false)
  }

  const fmt = (n: number) =>
    new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n)

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              💧 {tRef.current("cashflow.title")}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {tRef.current("cashflow.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="text-sm text-blue-600 hover:underline">
              ← {tRef.current("nav.dashboard")}
            </Link>
            <LanguageSwitcher />
          </div>
        </div>

        {/* Input form */}
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[180px]">
                <label className="block text-sm font-medium mb-1" htmlFor="sb">
                  {tRef.current("cashflow.startingBalance")}
                </label>
                <Input
                  id="sb"
                  data-testid="cashflow-starting-balance"
                  type="text"
                  inputMode="decimal"
                  value={startingBalance}
                  onChange={(e) => setStartingBalance(e.target.value)}
                  placeholder="0,00"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {tRef.current("cashflow.startingBalanceHint")}
                </p>
              </div>
              <div className="w-32">
                <label className="block text-sm font-medium mb-1" htmlFor="months">
                  {tRef.current("cashflow.months")}
                </label>
                <Input
                  id="months"
                  data-testid="cashflow-months"
                  type="number"
                  min={1}
                  max={36}
                  value={months}
                  onChange={(e) => setMonths(e.target.value)}
                />
              </div>
              <Button
                type="submit"
                disabled={submitting || loading}
                data-testid="cashflow-update"
              >
                {tRef.current("cashflow.update")}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Summary card */}
        {data && (
          <Card data-testid="cashflow-summary">
            <CardHeader>
              <CardTitle>{tRef.current("cashflow.summary")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("cashflow.totalIncoming")}</div>
                  <div className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                    +{fmt(data.summary.totalIncoming)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("cashflow.totalOutgoing")}</div>
                  <div className="font-mono text-red-600 dark:text-red-400 font-semibold">
                    −{fmt(data.summary.totalOutgoing)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("cashflow.totalNet")}</div>
                  <div className="font-mono font-semibold">
                    {fmt(data.summary.totalNet)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">{tRef.current("cashflow.endBalance")}</div>
                  <div
                    className={`font-mono font-bold ${
                      data.summary.endBalance < 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-gray-900 dark:text-gray-100"
                    }`}
                    data-testid="cashflow-end-balance"
                  >
                    {fmt(data.summary.endBalance)}
                  </div>
                </div>
              </div>
              <div className="mt-3 text-xs text-gray-500 flex flex-wrap gap-3">
                <span data-testid="cashflow-count-open-invoices">
                  {tRef.current("cashflow.openInvoices")}: <b>{data.counts.openInvoices}</b>
                </span>
                <span data-testid="cashflow-count-open-expenses">
                  {tRef.current("cashflow.openExpenses")}: <b>{data.counts.openExpenses}</b>
                </span>
                <span data-testid="cashflow-count-recurring">
                  {tRef.current("cashflow.recurringTemplates")}: <b>{data.counts.recurringTemplates}</b>
                </span>
              </div>
              <div
                className={`mt-3 p-3 rounded text-sm ${
                  data.summary.firstDryMonth
                    ? "bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800"
                    : "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800"
                }`}
                data-testid="cashflow-dry-warning"
              >
                {data.summary.firstDryMonth
                  ? `⚠ ${tRef.current("cashflow.firstDryMonth")}: ${data.summary.firstDryMonth} — ${tRef.current("cashflow.dryWarning")}`
                  : `✓ ${tRef.current("cashflow.noDry")}`}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Chart */}
        {data && (
          <Card>
            <CardHeader>
              <CardTitle>{tRef.current("cashflow.chartTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <CashflowChart data={data.months} />
            </CardContent>
          </Card>
        )}

        {/* Detailed table */}
        {data && (
          <Card>
            <CardContent className="pt-6">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="cashflow-table">
                  <thead>
                    <tr className="border-b text-xs text-gray-500 uppercase">
                      <th className="text-left py-2">{tRef.current("cashflow.month")}</th>
                      <th className="text-right py-2">{tRef.current("cashflow.incoming")}</th>
                      <th className="text-right py-2">{tRef.current("cashflow.outgoing")}</th>
                      <th className="text-right py-2">{tRef.current("cashflow.net")}</th>
                      <th className="text-right py-2">{tRef.current("cashflow.cumulative")}</th>
                      <th className="text-center py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.months.map((m) => (
                      <tr
                        key={m.month}
                        className={`border-b ${
                          m.isDry
                            ? "bg-red-50 dark:bg-red-900/20"
                            : ""
                        }`}
                        data-testid={`cashflow-row-${m.month}`}
                      >
                        <td className="py-2 font-mono">{m.label}</td>
                        <td className="text-right font-mono text-emerald-600 dark:text-emerald-400">
                          +{fmt(m.incoming)}
                        </td>
                        <td className="text-right font-mono text-red-600 dark:text-red-400">
                          −{fmt(m.outgoing)}
                        </td>
                        <td
                          className={`text-right font-mono font-semibold ${
                            m.net < 0
                              ? "text-red-600 dark:text-red-400"
                              : "text-emerald-700 dark:text-emerald-300"
                          }`}
                        >
                          {fmt(m.net)}
                        </td>
                        <td
                          className={`text-right font-mono ${
                            m.cumulative < 0
                              ? "text-red-600 dark:text-red-400 font-semibold"
                              : ""
                          }`}
                        >
                          {fmt(m.cumulative)}
                        </td>
                        <td className="text-center text-xs">
                          {m.isDry ? (
                            <span className="px-2 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200">
                              {tRef.current("cashflow.dryShort")}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
                              {tRef.current("cashflow.okShort")}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {loading && !data && (
          <p className="text-sm text-gray-500 text-center" data-testid="cashflow-loading">
            {tRef.current("cashflow.loading")}
          </p>
        )}
      </div>
    </main>
  )
}
