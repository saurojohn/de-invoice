"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost } from "@/lib/api"

interface CronHealthRow {
  name: string
  schedule: string
  timeZone: string
  status: "success" | "failed" | "skipped" | null
  lastRunAt: string | null
  lastDurationMs: number | null
  lastError: string | null
  lastSummary: string | null
  nextRunAt: string | null
  health: "green" | "red" | "amber" | "grey"
}

/**
 * System-Health page — Tier 119 admin dashboard.
 *
 * Renders the GET /api/v1/admin/cron-health response as
 * a small table with green/red/amber/grey dots. The
 * Berater (Steuerberater) + Mandant (the business owner)
 * both land here when "is the cron stuck?" is the
 * question — same rank as the system-errors page.
 *
 * Tier 119.5: 5 sections
 *   1. Header with the 4 health counts
 *   2. Table of every cron (sorted by health
 *      worst-first: red → amber → grey → green)
 *   3. Per-row "last error" expanded detail
 *   4. Manual "clean" button (POST /admin/cron-health/clean)
 *   5. Auto-refresh every 30s (matches the
 *      webhook-retry's 1-minute interval so the
 *      dashboard feels "live" without spamming the
 *      backend)
 */
export default function SystemHealthPage() {
  const { t, getDateLocale } = useI18n()
  const toast = useToast()
  const [rows, setRows] = useState<CronHealthRow[]>([])
  const [loading, setLoading] = useState(true)
  const [cleaning, setCleaning] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const res = await apiGet<CronHealthRow[]>(
        `/api/v1/admin/cron-health`,
      )
      setRows(res || [])
    } catch (e: any) {
      toast.error(t("systemHealth.loadingError") + ": " + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  // Initial load + auto-refresh every 30s.
  useEffect(() => {
    load()
    const i = setInterval(() => {
      load()
      setNow(Date.now())
    }, 30_000)
    // The "next run in 3m" label also wants a 1Hz
    // tick so the countdown updates without waiting
    // for the next 30s refresh.
    const j = setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      clearInterval(i)
      clearInterval(j)
    }
  }, [load])

  const clean = useCallback(async () => {
    if (!window.confirm(t("systemHealth.cleanConfirm"))) return
    setCleaning(true)
    try {
      const res = await apiPost<{ deleted: number }>(
        `/api/v1/admin/cron-health/clean`,
        {},
      )
      toast.success(
        t("systemHealth.cleaned").replace("{n}", String(res?.deleted ?? 0)),
      )
      load()
    } catch (e: any) {
      toast.error(t("systemHealth.loadingError") + ": " + (e?.message || e))
    } finally {
      setCleaning(false)
    }
  }, [t, toast, load])

  // Sort: red → amber → grey → green. Operators
  // want to see problems at the top, not buried in
  // a "freshest run" list.
  const sorted = [...rows].sort((a, b) => {
    const rank = { red: 0, amber: 1, grey: 2, green: 3 } as Record<string, number>
    return (rank[a.health] ?? 99) - (rank[b.health] ?? 99)
  })

  const counts = {
    green: rows.filter((r) => r.health === "green").length,
    amber: rows.filter((r) => r.health === "amber").length,
    red: rows.filter((r) => r.health === "red").length,
    grey: rows.filter((r) => r.health === "grey").length,
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("systemHealth.title")}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t("systemHealth.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={load}
            disabled={loading}
            data-testid="system-health-refresh"
          >
            {t("systemHealth.refresh")}
          </Button>
          <Button
            variant="secondary"
            onClick={clean}
            disabled={cleaning || loading}
            data-testid="system-health-clean"
          >
            {t("systemHealth.clean")}
          </Button>
        </div>
      </div>

      {/* Health summary chips — quick at-a-glance */}
      <div className="flex gap-3 text-sm">
        <HealthChip color="green" label={t("systemHealth.healthGreen")} count={counts.green} />
        <HealthChip color="amber" label={t("systemHealth.healthAmber")} count={counts.amber} />
        <HealthChip color="red" label={t("systemHealth.healthRed")} count={counts.red} />
        <HealthChip color="grey" label={t("systemHealth.healthGrey")} count={counts.grey} />
      </div>

      <Card>
        <CardContent className="pt-6">
          {loading && rows.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">
              {t("systemHealth.loading")}
            </p>
          ) : sorted.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">
              {t("systemHealth.noCrons")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="system-health-table">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-3">{t("systemHealth.healthGrey") /* "Health" */}</th>
                    <th className="text-left py-2 pr-3">Cron</th>
                    <th className="text-left py-2 pr-3">{t("systemHealth.schedule")}</th>
                    <th className="text-left py-2 pr-3">{t("systemHealth.lastRun")}</th>
                    <th className="text-left py-2 pr-3">{t("systemHealth.nextRun")}</th>
                    <th className="text-left py-2 pr-3">{t("systemHealth.lastSummary")}</th>
                    <th className="text-left py-2 pr-3">{t("systemHealth.lastError")}</th>
                    <th className="text-left py-2 pr-3">
                      {t("systemHealth.actions") || "Aktion"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <CronRow key={r.name} row={r} now={now} t={t} getDateLocale={getDateLocale} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function HealthChip({ color, label, count }: { color: string; label: string; count: number }) {
  const dotClass = {
    green: "bg-green-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    grey: "bg-gray-400",
  }[color]
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md border border-gray-200 dark:border-gray-700">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotClass}`} />
      <span className="font-medium">{count}</span>
      <span className="text-gray-600 dark:text-gray-400">{label}</span>
    </div>
  )
}

function CronRow({ row, now, t, getDateLocale }: {
  row: CronHealthRow
  now: number
  t: (k: string, vars?: Record<string, any>) => string
  getDateLocale: () => string
}) {
  const dotClass = {
    green: "bg-green-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    grey: "bg-gray-400",
  }[row.health]
  const healthLabel = {
    green: t("systemHealth.healthGreen"),
    amber: t("systemHealth.healthAmber"),
    red: t("systemHealth.healthRed"),
    grey: t("systemHealth.healthGrey"),
  }[row.health]
  return (
    <tr
      className="border-b last:border-b-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
      data-testid={`cron-row-${row.name}`}
      onClick={() => {
        // Tier 124: click on a cron row → drill into
        // its history. The page reads `:name` from
        // the URL and calls /admin/cron-health/:name/
        // history.
        if (typeof window !== "undefined") {
          window.location.href = `/dashboard/system-health/${encodeURIComponent(
            row.name,
          )}`
        }
      }}
    >
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2" title={healthLabel}>
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotClass}`} />
        </div>
      </td>
      <td className="py-2 pr-3 font-mono text-xs underline text-blue-600 dark:text-blue-400">
        {row.name}
      </td>
      <td className="py-2 pr-3 font-mono text-xs">
        {row.schedule} <span className="text-gray-500">({row.timeZone})</span>
      </td>
      <td className="py-2 pr-3 text-xs">
        {row.lastRunAt ? (
          <div>
            <div>{new Date(row.lastRunAt).toLocaleString(getDateLocale())}</div>
            <div className="text-gray-500">{relativeTime(row.lastRunAt, now, t)}</div>
            {row.lastDurationMs != null && (
              <div className="text-gray-500">{row.lastDurationMs}ms</div>
            )}
          </div>
        ) : (
          <span className="text-gray-400">{t("systemHealth.neverRan")}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-xs">
        {row.nextRunAt ? (
          <div>
            <div>{new Date(row.nextRunAt).toLocaleString(getDateLocale())}</div>
            <div className="text-gray-500">{relativeDelta(row.nextRunAt, now, t)}</div>
          </div>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-300">
        {row.lastSummary || "—"}
      </td>
      <td className="py-2 pr-3 text-xs">
        {row.lastError ? (
          <span className="text-red-600 dark:text-red-400" title={row.lastError}>
            {row.lastError.length > 60
              ? row.lastError.slice(0, 60) + "…"
              : row.lastError}
          </span>
        ) : (
          <span className="text-gray-400">{t("systemHealth.noError")}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-xs">
        {/*
          Tier 195 — per-row "Run now" button. Fires
          POST /admin/cron-health/:name/run and
          triggers a load() so the new lastRunAt
          shows up. We stop event propagation so
          the row click (drill into history) doesn't
          also fire.
        */}
        <Button
          size="sm"
          variant="outline"
          onClick={async (e) => {
            e.stopPropagation()
            try {
              await apiPost(
                `/api/v1/admin/cron-health/${encodeURIComponent(row.name)}/run`,
                {},
              )
              // Re-load after a short delay so the
              // cron's record() wrapper has a chance
              // to write the new lastRunAt row.
              setTimeout(() => {
                window.location.reload()
              }, 1500)
            } catch (err: any) {
              alert(
                (t("systemHealth.runFailed") || "Run fehlgeschlagen: ") +
                  (err?.message || String(err)),
              )
            }
          }}
          data-testid={`cron-run-${row.name}`}
        >
          {t("systemHealth.runNow") || "Jetzt ausführen"}
        </Button>
      </td>
    </tr>
  )
}

/**
 * Format "X minutes ago" with i18n. Falls back to
 * a compact "Xd" for old dates.
 */
function relativeTime(iso: string, now: number, t: (k: string, vars?: any) => string): string {
  const diff = now - new Date(iso).getTime()
  if (diff < 0) return ""
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "<1m"
  if (mins < 60) return t("systemHealth.minutesAgo").replace("{n}", String(mins))
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t("systemHealth.hoursAgo").replace("{n}", String(hours))
  const days = Math.floor(hours / 24)
  return t("systemHealth.daysAgo").replace("{n}", String(days))
}

function relativeDelta(iso: string, now: number, t: (k: string, vars?: any) => string): string {
  const diff = new Date(iso).getTime() - now
  if (diff < 0) {
    // Overdue (only happens for amber/red rows)
    const abs = Math.abs(diff)
    const mins = Math.floor(abs / 60_000)
    if (mins < 60) return t("systemHealth.nextRunOverdue").replace("{n}", `${mins}m`)
    const hours = Math.floor(mins / 60)
    if (hours < 24) return t("systemHealth.nextRunOverdue").replace("{n}", `${hours}h`)
    const days = Math.floor(hours / 24)
    return t("systemHealth.nextRunOverdue").replace("{n}", `${days}d`)
  }
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t("systemHealth.nextRunNow")
  if (mins < 60) return t("systemHealth.nextRunIn").replace("{n}", `${mins}m`)
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t("systemHealth.nextRunIn").replace("{n}", `${hours}h`)
  const days = Math.floor(hours / 24)
  return t("systemHealth.nextRunIn").replace("{n}", `${days}d`)
}