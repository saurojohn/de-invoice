"use client"

/**
 * Tier 124 — Cron health history drilldown.
 *
 * Renders the run history for a single cron,
 * fetched from
 *   GET /api/v1/admin/cron-health/:name/history
 *
 * Features:
 *   - 4 summary chips (success / failed / skipped
 *     count over the last 20 runs)
 *   - Average + p95 duration (helps spot a
 *     degrading cron before it goes red)
 *   - Status filter dropdown (all / success / failed /
 *     skipped) — wired into the URL via
 *     `?status=failed` so the Berater can bookmark
 *     "all failed runs of reminder-auto-send"
 *   - Table of runs (newest-first) with time,
 *     duration, status badge, summary, and
 *     (expandable) error message
 *   - "Mehr laden" button to page through 50 at
 *     a time
 *
 * Tier 119.5 already gave us the cron list + last-
 * run info. Tier 124 adds the deep history view.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet } from "@/lib/api"

interface HistoryRow {
  id: string
  name: string
  status: "success" | "failed" | "skipped"
  startedAt: string
  durationMs: number | null
  errorMessage: string | null
  summary: string | null
}

interface HistoryStats {
  successCount: number
  failedCount: number
  skippedCount: number
  avgDurationMs: number | null
  p95DurationMs: number | null
}

interface HistoryResponse {
  items: HistoryRow[]
  total: number
  stats: HistoryStats
}

const PAGE_SIZE = 50

function fmtMs(ms: number | null): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

const STATUS_COLORS: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  skipped: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
}

export default function CronHistoryPage() {
  const params = useParams()
  const router = useRouter()
  const search = useSearchParams()
  const { t, getDateLocale } = useI18n()
  const toast = useToast()
  const cronName = decodeURIComponent(String(params?.name || ""))

  // Status filter: read from URL, write to URL on
  // change. The URL is the source of truth so the
  // Berater can bookmark "all failed runs of X".
  const [statusFilter, setStatusFilter] = useState<"" | "success" | "failed" | "skipped">(
    () => {
      const s = search?.get("status")
      if (s === "success" || s === "failed" || s === "skipped") return s
      return ""
    },
  )

  const [rows, setRows] = useState<HistoryRow[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [skip, setSkip] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!cronName) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set("status", statusFilter)
      params.set("skip", String(skip))
      params.set("limit", String(PAGE_SIZE))
      const data = await apiGet<HistoryResponse>(
        `/api/v1/admin/cron-health/${encodeURIComponent(cronName)}/history?${params.toString()}`,
      )
      // When skip=0, replace. When skip>0, append
      // (for the "Mehr laden" button).
      if (skip === 0) {
        setRows(data.items)
      } else {
        setRows((prev) => [...prev, ...data.items])
      }
      setTotal(data.total)
      setStats(data.stats)
    } catch (e: any) {
      toast.error(t("cronHistory.loadError") + ": " + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [cronName, statusFilter, skip, t, toast])

  useEffect(() => {
    // Reset skip + rows when the filter changes
    // so we don't show stale rows from a different
    // status.
    setSkip(0)
    setRows([])
  }, [statusFilter])

  useEffect(() => {
    load()
  }, [load])

  // Sync statusFilter → URL on change (mirror of the
  // audit-timeline tier 122 pattern).
  useEffect(() => {
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    if (statusFilter) url.searchParams.set("status", statusFilter)
    else url.searchParams.delete("status")
    window.history.replaceState(null, "", url.toString())
  }, [statusFilter])

  const hasMore = rows.length < total

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold">
            {t("cronHistory.title")}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 font-mono">
            {cronName}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => router.push("/dashboard/system-health")}
          data-testid="cron-history-back"
        >
          {t("cronHistory.backToHealth")}
        </Button>
      </div>

      {/* Stats summary */}
      {stats && (
        <div
          className="flex flex-wrap gap-3 text-sm"
          data-testid="cron-history-stats"
        >
          <div
            className={`px-3 py-1 rounded-full font-medium ${STATUS_COLORS.success}`}
          >
            ✓ {stats.successCount} {t("cronHistory.success")}
          </div>
          <div
            className={`px-3 py-1 rounded-full font-medium ${STATUS_COLORS.failed}`}
          >
            ✗ {stats.failedCount} {t("cronHistory.failed")}
          </div>
          <div
            className={`px-3 py-1 rounded-full font-medium ${STATUS_COLORS.skipped}`}
          >
            ⊘ {stats.skippedCount} {t("cronHistory.skipped")}
          </div>
          <div className="px-3 py-1 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 font-mono">
            ⌀ {t("cronHistory.avgDuration")}: {fmtMs(stats.avgDurationMs)}
          </div>
          <div className="px-3 py-1 rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 font-mono">
            p95: {fmtMs(stats.p95DurationMs)}
          </div>
        </div>
      )}

      {/* Status filter */}
      <Card>
        <CardContent className="pt-6">
          <label className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">
            {t("cronHistory.filterByStatus")}
          </label>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(
                e.target.value as "" | "success" | "failed" | "skipped",
              )
            }}
            className="w-full sm:w-auto px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-sm"
            data-testid="cron-history-status-filter"
          >
            <option value="">{t("cronHistory.allStatuses")}</option>
            <option value="success">✓ {t("cronHistory.success")}</option>
            <option value="failed">✗ {t("cronHistory.failed")}</option>
            <option value="skipped">⊘ {t("cronHistory.skipped")}</option>
          </select>
        </CardContent>
      </Card>

      {/* History table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t("cronHistory.title")}</CardTitle>
            <span
              className="text-sm text-gray-600 dark:text-gray-300"
              data-testid="cron-history-total"
            >
              {rows.length} / {total}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {loading && rows.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">
              {t("cronHistory.loading")}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">
              {t("cronHistory.noRuns")}
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table
                  className="w-full text-sm"
                  data-testid="cron-history-table"
                >
                  <thead>
                    <tr className="text-left border-b">
                      <th className="py-2 pr-3 font-medium">
                        {t("cronHistory.startedAt")}
                      </th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                      <th className="py-2 pr-3 font-medium">
                        {t("cronHistory.duration")}
                      </th>
                      <th className="py-2 pr-3 font-medium">
                        {t("cronHistory.summary")}
                      </th>
                      <th className="py-2 pr-3 font-medium">
                        {t("cronHistory.error")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.id}
                        data-testid="cron-history-row"
                        className="border-b last:border-b-0"
                      >
                        <td className="py-2 pr-3 whitespace-nowrap font-mono text-xs">
                          {new Date(r.startedAt).toLocaleString(getDateLocale())}
                        </td>
                        <td className="py-2 pr-3">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-medium ${
                              STATUS_COLORS[r.status] || STATUS_COLORS.skipped
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">
                          {fmtMs(r.durationMs)}
                        </td>
                        <td className="py-2 pr-3 text-xs text-gray-700 dark:text-gray-300">
                          {r.summary || "—"}
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          {r.errorMessage ? (
                            <pre
                              className="bg-red-50 dark:bg-red-900/20 p-2 rounded text-xs overflow-x-auto max-w-md border border-red-200 dark:border-red-800"
                              data-testid="cron-history-error"
                            >
                              {r.errorMessage}
                            </pre>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hasMore && (
                <div className="flex justify-center mt-4">
                  <Button
                    onClick={() => setSkip((s) => s + PAGE_SIZE)}
                    disabled={loading}
                    variant="outline"
                    size="sm"
                    data-testid="cron-history-load-more"
                  >
                    {t("cronHistory.loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
