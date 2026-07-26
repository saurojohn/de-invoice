"use client"

// Tier 108: SEPA pain.001 batch payments.
//
// The Berater (or Mandant) opens this page, sees the
// "unpaid" Eingangsrechnungen (status='booked', paidAt IS
// NULL, supplier with valid IBAN), checks the rows to
// pay, picks an execution date, and clicks "Create batch".
// The backend bundles them into one pain.001.001.09 XML
// the user downloads + uploads to the house bank's
// online banking portal.
//
// Two cards:
//   1. Offene Ausgaben — checkbox list + sticky
//      "Create batch" CTA. Selecting 0 disables the CTA.
//   2. Bisherige Batches — list of generated SepaBatch
//      rows with execution date, total amount, payment
//      count, and a per-row "Download XML" button.
//
// Empty states:
//   - Keine offenen Ausgaben (no IBANs) → green hint
//     with link to /dashboard/suppliers
//   - Keine Bisherigen Batches → neutral hint
//
// The page also surfaces the debtor IBAN (from the
// Company settings) at the top so the user can see
// which account the batch will be drawn from before
// confirming.

import { useEffect, useState, useCallback, useMemo, useRef } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, ApiError } from "@/lib/api"

interface UnpaidExpense {
  id: string
  invoiceNumber: string | null
  description: string
  invoiceDate: string
  netAmount: string
  vatAmount: string
  grossAmount: string
  vatRate: string
  status: string
  category: string | null
  supplier: {
    id: string
    name: string
    bankInfo: { iban: string; bic?: string | null; kontoinhaber?: string | null } | null
  } | null
}

interface SepaBatchRow {
  id: string
  paymentCount: number
  totalAmount: string
  debtorIban: string
  debtorName: string
  executionDate: string
  status: string
  notes: string | null
  createdAt: string
}

function fmtMoney(n: number | string) {
  const v = typeof n === "string" ? Number(n) : n
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v || 0)
}

function fmtDateDE(d: string | null) {
  if (!d) return "—"
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}.${dt.getFullYear()}`
}

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function plusDaysISO(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function statusBadgeColor(s: string) {
  if (s === "generated") return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
  if (s === "submitted") return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
  if (s === "confirmed") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
  if (s === "failed") return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
  return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200"
}

export default function PaymentsPage() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t

  const [unpaid, setUnpaid] = useState<UnpaidExpense[]>([])
  const [batches, setBatches] = useState<SepaBatchRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [executionDate, setExecutionDate] = useState<string>(plusDaysISO(2))
  const [notes, setNotes] = useState<string>("")
  const [creating, setCreating] = useState(false)
  const [lastBatchId, setLastBatchId] = useState<string | null>(null)

  const companyId =
    typeof window !== "undefined" ? localStorage.getItem("companyId") : null

  const load = useCallback(async () => {
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    try {
      const [u, b] = await Promise.all([
        apiGet<UnpaidExpense[]>(
          `/api/v1/payments/unpaid?companyId=${companyId}`,
        ),
        apiGet<SepaBatchRow[]>(
          `/api/v1/payments/batches?companyId=${companyId}`,
        ),
      ])
      setUnpaid(u)
      setBatches(b)
      setError(null)
    } catch (err: any) {
      setError(
        err?.message || tRef.current("payments.loadError") || "Fehler",
      )
    } finally {
      setLoading(false)
    }
  }, [companyId, router])

  useEffect(() => {
    load()
  }, [load])

  const totalSelected = useMemo(
    () =>
      unpaid
        .filter((e) => selected.has(e.id))
        .reduce((sum, e) => sum + Number(e.grossAmount || 0), 0),
    [unpaid, selected],
  )

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === unpaid.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(unpaid.map((e) => e.id)))
    }
  }

  const handleCreate = async () => {
    if (selected.size === 0) {
      toastRef.current.warn(tRef.current("payments.requireSelection"))
      return
    }
    if (!executionDate) {
      toastRef.current.warn(tRef.current("payments.executionDate"))
      return
    }
    if (executionDate < todayISO()) {
      toastRef.current.warn(tRef.current("payments.executionDateFuture"))
      return
    }
    setCreating(true)
    try {
      const result = await apiPost<{ id: string; paymentCount: number; totalAmount: number }>(
        "/api/v1/payments/batches",
        {
          companyId,
          expenseIds: Array.from(selected),
          executionDate,
          notes: notes || undefined,
        },
      )
      setLastBatchId(result.id)
      setSelected(new Set())
      setNotes("")
      toastRef.current.success(tRef.current("payments.batchCreated"))
      await load()
    } catch (err: any) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err?.message || tRef.current("payments.createError")
      toastRef.current.error(msg)
    } finally {
      setCreating(false)
    }
  }

  const handleDownloadXml = async (batchId: string) => {
    try {
      const url = `/api/v1/payments/batches/${batchId}/xml?companyId=${companyId}`
      const res = await fetch(url, {
        headers: {
          "x-user-id": localStorage.getItem("userId") || "",
          "x-company-id": companyId || "",
        },
        credentials: "include",
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = blobUrl
      a.download = `SEPA_${batchId}.xml`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    } catch (err: any) {
      toastRef.current.error(
        err?.message || tRef.current("payments.loadError"),
      )
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900" data-testid="payments-page">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400" data-testid="payments-title">
            {t("payments.title")}
          </h1>
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <LanguageSwitcher />
            <ThemeToggle />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              ← {t("dashboard.title")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 space-y-6">
        {/* Subtitle + explanation */}
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
              {t("payments.subtitle")}
            </p>
          </CardContent>
        </Card>

        {error && (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Unpaid expenses card */}
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>{t("payments.unpaidExpenses") || "Offene Ausgaben"}</CardTitle>
              {unpaid.length > 0 && (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 dark:text-gray-300" data-testid="payments-selected-count">
                    {selected.size} / {unpaid.length} {t("payments.selected")}
                  </span>
                  <Button variant="outline" size="sm" onClick={toggleAll} data-testid="payments-select-all">
                    {selected.size === unpaid.length
                      ? "—"
                      : t("payments.selectAll")}
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-gray-500">…</p>
            ) : unpaid.length === 0 ? (
              <p className="text-sm text-emerald-700 dark:text-emerald-400" data-testid="payments-empty">
                {t("payments.empty")}{" "}
                <Link
                  href="/dashboard/suppliers"
                  className="underline hover:no-underline"
                >
                  /dashboard/suppliers
                </Link>
              </p>
            ) : (
              <>
                <div className="overflow-x-auto" data-testid="payments-unpaid-table">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b dark:border-gray-700">
                        <th className="py-2 pr-3 w-8"></th>
                        <th className="py-2 pr-3">{t("payments.invoiceDate")}</th>
                        <th className="py-2 pr-3">{t("payments.invoiceNumber")}</th>
                        <th className="py-2 pr-3">{t("payments.supplier")}</th>
                        <th className="py-2 pr-3">{t("payments.description")}</th>
                        <th className="py-2 pr-3 text-right">{t("payments.amount")}</th>
                        <th className="py-2 pr-3">IBAN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unpaid.map((e) => {
                        const iban = e.supplier?.bankInfo?.iban
                        return (
                          <tr
                            key={e.id}
                            className={`border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer ${
                              selected.has(e.id)
                                ? "bg-blue-50 dark:bg-blue-900/20"
                                : ""
                            }`}
                            onClick={() => toggleOne(e.id)}
                            data-testid={`unpaid-row-${e.id}`}
                          >
                            <td className="py-2 pr-3">
                              <input
                                type="checkbox"
                                className="w-4 h-4"
                                checked={selected.has(e.id)}
                                onChange={() => toggleOne(e.id)}
                                onClick={(ev) => ev.stopPropagation()}
                                data-testid={`unpaid-checkbox-${e.id}`}
                              />
                            </td>
                            <td className="py-2 pr-3 whitespace-nowrap">
                              {fmtDateDE(e.invoiceDate)}
                            </td>
                            <td className="py-2 pr-3 whitespace-nowrap font-mono text-xs">
                              {e.invoiceNumber || "—"}
                            </td>
                            <td className="py-2 pr-3">
                              {e.supplier?.name || "—"}
                            </td>
                            <td className="py-2 pr-3 max-w-xs truncate">
                              {e.description}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono whitespace-nowrap">
                              {fmtMoney(e.grossAmount)} €
                            </td>
                            <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                              {iban ? iban.slice(0, 8) + "…" : t("payments.noIban")}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Sticky-ish create-batch footer */}
                <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700" data-testid="payments-create-form">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                    <div>
                      <Label htmlFor="executionDate">
                        {t("payments.executionDate")}
                      </Label>
                      <Input
                        id="executionDate"
                        type="date"
                        value={executionDate}
                        onChange={(ev) => setExecutionDate(ev.target.value)}
                        min={todayISO()}
                        data-testid="execution-date-input"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <Label htmlFor="notes">{t("payments.notes")}</Label>
                      <Input
                        id="notes"
                        type="text"
                        value={notes}
                        onChange={(ev) => setNotes(ev.target.value)}
                        placeholder={t("payments.notes")}
                        data-testid="notes-input"
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm text-gray-600 dark:text-gray-300">
                      Σ <span className="font-mono font-bold">{fmtMoney(totalSelected)} €</span>
                    </div>
                    <Button
                      onClick={handleCreate}
                      disabled={selected.size === 0 || creating}
                      data-testid="create-batch-button"
                    >
                      {creating
                        ? "…"
                        : `${t("payments.createBatch")} (${selected.size})`}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Past batches card */}
        <Card>
          <CardHeader>
            <CardTitle>{t("payments.batches")}</CardTitle>
          </CardHeader>
          <CardContent>
            {batches.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="payments-no-batches">
                {t("payments.noBatches")}
              </p>
            ) : (
              <div className="overflow-x-auto" data-testid="payments-batches-table">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b dark:border-gray-700">
                      <th className="py-2 pr-3">{t("payments.createdAt")}</th>
                      <th className="py-2 pr-3">{t("payments.executionLabel")}</th>
                      <th className="py-2 pr-3">{t("payments.paymentCount")}</th>
                      <th className="py-2 pr-3 text-right">{t("payments.totalAmount")}</th>
                      <th className="py-2 pr-3">{t("payments.debtorName")}</th>
                      <th className="py-2 pr-3">{t("payments.status")}</th>
                      <th className="py-2 pr-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr
                        key={b.id}
                        className="border-b dark:border-gray-700"
                        data-testid={`batch-row-${b.id}`}
                      >
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {fmtDateDE(b.createdAt)}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap font-mono">
                          {fmtDateDE(b.executionDate)}
                        </td>
                        <td className="py-2 pr-3 font-mono text-right">
                          {b.paymentCount}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono whitespace-nowrap">
                          {fmtMoney(b.totalAmount)} €
                        </td>
                        <td className="py-2 pr-3 max-w-[200px] truncate">
                          {b.debtorName}
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={`inline-block px-2 py-0.5 text-xs rounded ${statusBadgeColor(b.status)}`}
                          >
                            {b.status}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDownloadXml(b.id)}
                            data-testid={`download-xml-${b.id}`}
                          >
                            {t("payments.downloadXml")}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {lastBatchId && (
              <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
                ✓ {t("payments.batchCreated")}{" "}
                <button
                  className="underline hover:no-underline"
                  onClick={() => handleDownloadXml(lastBatchId)}
                >
                  {t("payments.downloadXml")}
                </button>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
