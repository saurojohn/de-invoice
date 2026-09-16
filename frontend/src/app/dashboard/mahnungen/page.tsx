"use client"

// Tier 37: Mahnhistorie (dunning audit trail).
//
// Shows every sent Mahnung (Zahlungserinnerung / 1. Mahnung
// / Letzte Mahnung) for the company, with the per-letter
// fees: Mahngebühr + Verzugszins (§288 BGB), plus the
// totalDue snapshot. Each row exposes:
//   - PDF download (regenerated on demand from the audit
//     row + the original invoice — see
//     reminder.controller.downloadMahnungPdf)
//   - Cancel (soft-delete; the audit row stays put)
//
// Filter is at the page level (open / cancelled / all).
// Defaults to "open" because the email/cron pipeline
// creates dozens of these over a quarter — the user
// usually wants to see "what's still outstanding".

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, downloadApiFile } from "@/lib/api"
import { signOut } from "@/lib/auth"

interface MahnungRow {
  id: string
  invoiceId: string
  invoiceNumber: string
  customerName: string
  customerNumber: string | null
  issueDate: string
  dueDate: string | null
  invoiceTotal: number
  // Tier 40: cost-center stamps carried over from the
  // source Invoice. Both nullable — the row shows "—"
  // when the source invoice never stamped a cost-center.
  costCenter: string | null
  costObject: string | null
  level: "first" | "second" | "final"
  daysOverdue: number
  neueFrist: string
  mahngebuehr: number
  verzugszins: number
  totalDue: number
  recipientEmail: string
  recipientName: string | null
  sentAt: string
  sentById: string | null
  cancelledAt: string | null
  cancelledById: string | null
  cancelReason: string | null
}

type Filter = "open" | "cancelled" | "all"

function fmtMoney(n: number) {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n || 0)
}

function fmtDateDE(d: string | null) {
  if (!d) return "—"
  const dt = new Date(d)
  return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}.${dt.getFullYear()}`
}

function fmtDateTimeDE(d: string | null) {
  if (!d) return "—"
  const dt = new Date(d)
  const date = `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}.${dt.getFullYear()}`
  const time = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`
  return `${date} ${time}`
}

function levelLabel(level: string): string {
  if (level === "first") return "Zahlungserinnerung"
  if (level === "second") return "1. Mahnung"
  return "Letzte Mahnung"
}

function levelBadgeColor(level: string) {
  if (level === "first") return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
  if (level === "second") return "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200"
  return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
}

export default function MahnhistoriePage() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  const [rows, setRows] = useState<MahnungRow[]>([])
  const [filter, setFilter] = useState<Filter>("open")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState("")

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    apiGet<{ mahnungen: MahnungRow[]; count: number }>(
      `/api/v1/reminders/mahnungen?companyId=${companyId}&status=${filter}`,
    )
      .then((d) => {
        setRows(d.mahnungen)
        setLoading(false)
      })
      .catch((err: any) => {
        setError(err?.message || "Unbekannter Fehler")
        setLoading(false)
      })
  }, [filter, router])

  async function handleCancel(row: MahnungRow) {
    if (!cancelReason.trim()) {
      toast.warn(t("mahnung.cancelReason") + " (erforderlich)")
      return
    }
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setCancelling(row.id)
    try {
      await apiPost(
        `/api/v1/reminders/mahnungen/${row.id}/cancel?companyId=${companyId}`,
        { reason: cancelReason.trim() },
      )
      // Refresh — mark as cancelled locally to avoid the round-trip.
      setRows((curr) =>
        curr.map((r) =>
          r.id === row.id
            ? { ...r, cancelledAt: new Date().toISOString(), cancelReason }
            : r,
        ),
      )
      setCancelling(null)
      setCancelReason("")
    } catch (err: any) {
      toast.error(err?.message || "Stornierung fehlgeschlagen")
      setCancelling(null)
    }
  }

  function downloadPdf(row: MahnungRow) {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    // Tier 389: fetched with the auth headers and opened as a blob — a
    // window.open to the API sends no headers (401), and without
    // NEXT_PUBLIC_API_URL the URL started with "undefined".
    downloadApiFile(`/api/v1/reminders/mahnungen/${row.id}/pdf?companyId=${companyId}`, {
      newTab: true,
    }).catch((e: any) => toast.error(e?.message || "PDF konnte nicht geladen werden"))
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        {/* Tier 125: flex-wrap + responsive header — same
            pattern as the invoices/customers list pages
            in Tier 121. */}
        <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <h1
              className="text-xl sm:text-2xl font-bold text-blue-600 dark:text-blue-400"
              data-testid="mahnhistorie-title"
            >
              {t("mahnung.title")}
            </h1>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/dashboard/reminders")}
            >
              ← {t("nav.reminders") || "Mahnungen"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/dashboard/mahnungen/settings")}
              data-testid="mahnung-settings-button"
            >
              ⚙ {t("mahnung.settings")}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
            <Button
              variant="outline"
              onClick={async () => {
                // Tier 401: revoke the session server-side first — clearing
                // localStorage used to leave the credential valid.
                await signOut()
                router.push("/login")
              }}
            >
              {t("dashboard.logout")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8">
        {/* Filter tabs */}
        <div
          className="flex gap-2 mb-4"
          data-testid="mahnung-filter-tabs"
        >
          {(["open", "cancelled", "all"] as Filter[]).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(f)}
              data-testid={`mahnung-filter-${f}`}
            >
              {t(`mahnung.${f === "all" ? "showAll" : f === "open" ? "showOnlyOpen" : "showOnlyCancelled"}`)}
            </Button>
          ))}
        </div>

        {loading && (
          <div
            className="text-center py-12 text-gray-500"
            data-testid="mahnhistorie-loading"
          >
            Lade Mahnhistorie…
          </div>
        )}
        {error && (
          <div
            className="p-4 bg-red-50 border border-red-200 text-red-800 rounded"
            data-testid="mahnhistorie-error"
          >
            ✗ {error}
          </div>
        )}
        {!loading && !error && rows.length === 0 && (
          <div
            className="text-center py-12 text-gray-400"
            data-testid="mahnhistorie-empty"
          >
            {t("mahnung.noMahnungen")}
          </div>
        )}
        {!loading && rows.length > 0 && (
          <Card data-testid="mahnhistorie-card">
            <CardHeader>
              <CardTitle>
                {t("mahnung.subtitle")} ({rows.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table
                  className="w-full min-w-[640px] text-sm"
                  data-testid="mahnhistorie-table"
                >
                  <thead>
                    <tr className="text-left border-b border-gray-200 dark:border-gray-700 text-xs uppercase text-gray-500">
                      <th className="py-2 pr-4">{t("mahnung.level")}</th>
                      <th className="py-2 pr-4">Rechnung</th>
                      <th className="py-2 pr-4">Kunde</th>
                      {/* Tier 40: cost-center stamp. Hidden
                          when both columns are empty so the
                          table doesn't sprout dead weight;
                          rendered as compact "VERTRIEB" /
                          "PROJ-…" so the Berater sees the
                          assignment at a glance. */}
                      <th className="py-2 pr-4">
                        {t("mahnung.costCenter")}
                      </th>
                      <th className="py-2 pr-4 text-right">
                        {t("mahnung.daysOverdue")}
                      </th>
                      <th className="py-2 pr-4">
                        {t("mahnung.sent")}
                      </th>
                      <th className="py-2 pr-4 text-right">
                        {t("mahnung.mahngebuehr")}
                      </th>
                      <th className="py-2 pr-4 text-right">
                        {t("mahnung.verzugszins")}
                      </th>
                      <th className="py-2 pr-4 text-right">
                        {t("mahnung.totalDue")}
                      </th>
                      <th className="py-2 pr-4">
                        {t("mahnung.actions")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800"
                        data-testid="mahnhistorie-row"
                        data-mahnung-id={r.id}
                      >
                        <td className="py-3 pr-4">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs ${levelBadgeColor(r.level)}`}
                            data-testid="mahnung-level"
                          >
                            {levelLabel(r.level)}
                          </span>
                        </td>
                        <td className="py-3 pr-4">
                          <button
                            type="button"
                            className="font-mono text-blue-600 hover:underline"
                            onClick={() =>
                              router.push(
                                `/dashboard/invoices/${r.invoiceId}`,
                              )
                            }
                            data-testid="mahnung-invoice-number"
                          >
                            {r.invoiceNumber}
                          </button>
                          <div className="text-xs text-gray-400">
                            {fmtDateDE(r.dueDate)}
                          </div>
                        </td>
                        <td className="py-3 pr-4">
                          <div>{r.customerName}</div>
                          {r.customerNumber && (
                            <div className="text-xs text-gray-400 font-mono">
                              {r.customerNumber}
                            </div>
                          )}
                        </td>
                        <td
                          className="py-3 pr-4 text-xs"
                          data-testid="mahnung-cost-center-cell"
                        >
                          {r.costCenter || r.costObject ? (
                            <div
                              data-testid="mahnung-cost-center-value"
                            >
                              <div className="font-mono">
                                {r.costCenter || "—"}
                              </div>
                              {r.costObject && (
                                <div className="text-gray-400 font-mono">
                                  {r.costObject}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-right font-mono">
                          {r.daysOverdue}
                        </td>
                        <td className="py-3 pr-4 text-xs">
                          {fmtDateTimeDE(r.sentAt)}
                        </td>
                        <td className="py-3 pr-4 text-right font-mono">
                          {fmtMoney(r.mahngebuehr)} €
                        </td>
                        <td className="py-3 pr-4 text-right font-mono">
                          {fmtMoney(r.verzugszins)} €
                        </td>
                        <td className="py-3 pr-4 text-right font-mono font-bold">
                          {fmtMoney(r.totalDue)} €
                        </td>
                        <td className="py-3 pr-4">
                          {r.cancelledAt ? (
                            <span className="text-xs text-gray-400">
                              {t("mahnung.cancelledAt")} {fmtDateDE(r.cancelledAt)}
                              {r.cancelReason && (
                                <div className="text-gray-500 italic max-w-[200px] truncate">
                                  „{r.cancelReason}"
                                </div>
                              )}
                            </span>
                          ) : cancelling === r.id ? (
                            <div className="flex flex-col gap-1">
                              <input
                                type="text"
                                value={cancelReason}
                                onChange={(e) =>
                                  setCancelReason(e.target.value)
                                }
                                placeholder={t("mahnung.cancelReason")}
                                className="px-2 py-1 border rounded text-xs w-32 dark:bg-gray-800 dark:border-gray-700"
                                data-testid="mahnung-cancel-reason"
                              />
                              <div className="flex gap-1">
                                <button
                                  type="button"
                                  className="text-xs px-2 py-1 bg-red-600 text-white rounded"
                                  onClick={() => handleCancel(r)}
                                  data-testid="mahnung-cancel-confirm"
                                >
                                  ✓
                                </button>
                                <button
                                  type="button"
                                  className="text-xs px-2 py-1 bg-gray-300 rounded dark:bg-gray-700"
                                  onClick={async () => {
                                    setCancelling(null)
                                    setCancelReason("")
                                  }}
                                >
                                  ✗
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => downloadPdf(r)}
                                className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                                data-testid="mahnung-download-pdf"
                              >
                                PDF
                              </button>
                              <button
                                type="button"
                                onClick={() => setCancelling(r.id)}
                                className="text-xs px-2 py-1 bg-red-50 border border-red-200 text-red-800 rounded hover:bg-red-100"
                                data-testid="mahnung-cancel-button"
                              >
                                ✗
                              </button>
                            </div>
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
      </div>
    </main>
  )
}