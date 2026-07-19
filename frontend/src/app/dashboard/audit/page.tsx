"use client"

/**
 * Tier 67: Audit-Trail UI (GoBD § 147 AO).
 *
 * Lists every change recorded by the Prisma audit
 * extension (prisma/audit-log.extension.ts), with
 * filters for entity type, user, action, and date
 * range. Each row is clickable — opens a modal with
 * the old / new JSON for a before/after diff.
 *
 * The CSV export button hits /audit-logs/export.csv
 * which returns a GoBD-grade CSV (UTF-8 BOM, RFC 4180
 * escaping). The auditor can hand the file to the
 * Finanzamt directly.
 *
 * Why a separate "Audit" page instead of folding
 * into System-Errors: System-Errors is for runtime
 * errors (uncaught exceptions). Audit is for the
 * "who changed what" trail — different data, different
 * user (a Steuerberater cares about the audit trail
 * even when no errors have happened).
 *
 * Why no bulk actions: the audit log is append-only.
 * There is no "delete" or "edit" — that would defeat
 * the GoBD requirement.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet } from "@/lib/api"

interface AuditRow {
  id: string
  action: string
  entityType: string | null
  entityId: string | null
  userId: string | null
  userEmail: string | null
  ipAddress: string | null
  createdAt: string
}

interface AuditDetail {
  id: string
  action: string
  entityType: string | null
  entityId: string | null
  userId: string | null
  userEmail: string | null
  ipAddress: string | null
  userAgent: string | null
  oldData: any
  newData: any
  createdAt: string
}

interface StatsResponse {
  totalActions: number
  byAction: { action: string; count: number }[]
  byEntityType: { entityType: string; count: number }[]
  byUser: { userId: string | null; count: number }[]
  newestChange: string | null
}

const fmtDate = (s: string | null | undefined, locale = "de-DE") =>
  s
    ? new Date(s).toLocaleString(locale, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—"

const fmtShort = (s: string | null | undefined, locale = "de-DE") =>
  s
    ? new Date(s).toLocaleDateString(locale, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      })
    : "—"

export default function AuditPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  const toast = useToast()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  // Filters
  const [entityType, setEntityType] = useState("")
  const [actionPrefix, setActionPrefix] = useState("")
  const [userId, setUserId] = useState("")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")
  const [skip, setSkip] = useState(0)
  const TAKE = 50

  // Detail modal
  const [detail, setDetail] = useState<AuditDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const companyId =
    typeof window !== "undefined" ? localStorage.getItem("companyId") : null

  // useRef mirror for t / toast so the load callback
  // can read the latest values without re-creating on
  // every render. Putting t/toast directly in the
  // useCallback deps would create an infinite render
  // loop (every render → new t object → new callback →
  // useEffect re-fires → re-render).
  const tRef = useRef(t)
  const toastRef = useRef(toast)
  useEffect(() => {
    tRef.current = t
    toastRef.current = toast
  }, [t, toast])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set("companyId", companyId)
      if (entityType) params.set("entityType", entityType)
      if (actionPrefix) params.set("actionPrefix", actionPrefix)
      if (userId) params.set("userId", userId)
      if (dateFrom) params.set("dateFrom", dateFrom)
      if (dateTo) params.set("dateTo", dateTo + "T23:59:59.999Z")
      params.set("skip", String(skip))
      params.set("take", String(TAKE))
      const [data, statsData] = await Promise.all([
        apiGet<{ rows: AuditRow[]; total: number; take: number; skip: number }>(
          `/api/v1/audit-logs?${params.toString()}`,
        ),
        skip === 0
          ? apiGet<StatsResponse>(`/api/v1/audit-logs/stats?companyId=${companyId}`)
          : Promise.resolve(null),
      ])
      setRows(data.rows)
      setTotal(data.total)
      if (statsData) setStats(statsData)
    } catch (e: any) {
      // Read the latest toast / t through refs so
      // we don't capture stale closure values.
      toastRef.current.error(e?.message || tRef.current("common.loadError"))
    } finally {
      setLoading(false)
    }
  }, [companyId, entityType, actionPrefix, userId, dateFrom, dateTo, skip])

  useEffect(() => {
    if (!companyId) {
      router.push("/login")
      return
    }
    load()
  }, [companyId, load, router])

  const resetFilters = () => {
    setEntityType("")
    setActionPrefix("")
    setUserId("")
    setDateFrom("")
    setDateTo("")
    setSkip(0)
  }

  const openDetail = async (id: string) => {
    setLoadingDetail(true)
    setDetail(null)
    try {
      const data = await apiGet<AuditDetail>(
        `/api/v1/audit-logs/${id}?companyId=${companyId}`,
      )
      setDetail(data)
    } catch (e: any) {
      toast.error(e?.message || t("common.loadError"))
    } finally {
      setLoadingDetail(false)
    }
  }

  const closeDetail = () => setDetail(null)

  const entityTypeOptions = useMemo(() => {
    // Build from the stats response so the dropdown
    // only shows entity types that actually have
    // log entries. Avoids an empty <option> for
    // entity types the tenant never touches.
    const set = new Set<string>()
    stats?.byEntityType.forEach((b) => {
      if (b.entityType && b.entityType !== "(none)") set.add(b.entityType)
    })
    return Array.from(set).sort()
  }, [stats])

  const exportCsvUrl = useMemo(() => {
    if (!companyId) return "#"
    const params = new URLSearchParams()
    params.set("companyId", companyId)
    if (entityType) params.set("entityType", entityType)
    if (actionPrefix) params.set("actionPrefix", actionPrefix)
    if (userId) params.set("userId", userId)
    if (dateFrom) params.set("dateFrom", dateFrom)
    if (dateTo) params.set("dateTo", dateTo + "T23:59:59.999Z")
    const base =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    const userIdLocal =
      typeof window !== "undefined"
        ? localStorage.getItem("userId") || ""
        : ""
    // We return a URL the user can hit directly —
    // the browser sends cookies for the
    // authentication, but our backend uses
    // x-user-id / x-company-id headers, not
    // cookies. So we use a fetch-and-download
    // helper instead of a plain href. The href
    // is still useful as the "Copy link" target.
    return `${base}/api/v1/audit-logs/export.csv?${params.toString()}`
  }, [companyId, entityType, actionPrefix, userId, dateFrom, dateTo])

  const downloadCsv = async () => {
    if (!companyId) return
    try {
      const params = new URLSearchParams()
      params.set("companyId", companyId)
      if (entityType) params.set("entityType", entityType)
      if (actionPrefix) params.set("actionPrefix", actionPrefix)
      if (userId) params.set("userId", userId)
      if (dateFrom) params.set("dateFrom", dateFrom)
      if (dateTo) params.set("dateTo", dateTo + "T23:59:59.999Z")
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}/api/v1/audit-logs/export.csv?${params.toString()}`,
        {
          headers: {
            "x-user-id": localStorage.getItem("userId") || "",
            "x-company-id": companyId,
          },
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e: any) {
      toast.error(e?.message || t("common.loadError"))
    }
  }

  const hasMore = skip + TAKE < total

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t("audit.title") || "Audit-Trail"}
          </h1>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={downloadCsv}
              data-testid="audit-export-csv"
            >
              📥 {t("audit.exportCsv") || "CSV exportieren"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/dashboard")}
            >
              ← {t("common.back") || "Zurück"}
            </Button>
          </div>
        </div>

        {/* Stats cards */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold" data-testid="audit-stat-total">
                  {stats.totalActions.toLocaleString("de-DE")}
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t("audit.totalActions") || "Änderungen gesamt"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold" data-testid="audit-stat-newest">
                  {fmtShort(stats.newestChange, getDateLocale())}
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t("audit.newestChange") || "Letzte Änderung"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold">
                  {stats.byEntityType.length}
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t("audit.entityTypes") || "Entitätstypen"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="text-2xl font-bold">{stats.byUser.length}</div>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t("audit.users") || "Benutzer"}
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Filters */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg">
              {t("audit.filters") || "Filter"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                  {t("audit.entityType") || "Entitätstyp"}
                </label>
                <select
                  value={entityType}
                  onChange={(e) => {
                    setEntityType(e.target.value)
                    setSkip(0)
                  }}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-sm"
                  data-testid="audit-filter-entityType"
                >
                  <option value="">— {t("common.all") || "Alle"} —</option>
                  {entityTypeOptions.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                  {t("audit.actionPrefix") || "Aktion (Präfix)"}
                </label>
                <input
                  type="text"
                  value={actionPrefix}
                  onChange={(e) => {
                    setActionPrefix(e.target.value)
                    setSkip(0)
                  }}
                  placeholder="z.B. invoice."
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-sm"
                  data-testid="audit-filter-action"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                  {t("audit.userId") || "Benutzer-ID"}
                </label>
                <input
                  type="text"
                  value={userId}
                  onChange={(e) => {
                    setUserId(e.target.value)
                    setSkip(0)
                  }}
                  placeholder="8c6a9669-..."
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-sm"
                  data-testid="audit-filter-userId"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                  {t("audit.dateFrom") || "Datum von"}
                </label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value)
                    setSkip(0)
                  }}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-sm"
                  data-testid="audit-filter-dateFrom"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                  {t("audit.dateTo") || "Datum bis"}
                </label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => {
                    setDateTo(e.target.value)
                    setSkip(0)
                  }}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-sm"
                  data-testid="audit-filter-dateTo"
                />
              </div>
              <div className="flex items-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={resetFilters}
                  data-testid="audit-filter-reset"
                >
                  ↺ {t("audit.resetFilters") || "Zurücksetzen"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* List */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">
                {t("audit.list") || "Änderungsprotokoll"}
              </CardTitle>
              <span className="text-sm text-gray-600 dark:text-gray-300" data-testid="audit-total">
                {total.toLocaleString("de-DE")} {t("audit.entries") || "Einträge"}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-12 text-gray-500">
                {t("common.loading") || "Wird geladen…"}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                title={t("audit.empty") || "Keine Einträge"}
                description={
                  t("audit.emptyDesc") ||
                  "Für die aktuellen Filter wurden keine Änderungen gefunden."
                }
                variant="search"
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="audit-table">
                    <thead>
                      <tr className="text-left border-b border-gray-200 dark:border-gray-700">
                        <th className="py-2 px-2 font-medium">
                          {t("audit.timestamp") || "Zeitstempel"}
                        </th>
                        <th className="py-2 px-2 font-medium">
                          {t("audit.action") || "Aktion"}
                        </th>
                        <th className="py-2 px-2 font-medium">
                          {t("audit.entityType") || "Entität"}
                        </th>
                        <th className="py-2 px-2 font-medium">
                          {t("audit.user") || "Benutzer"}
                        </th>
                        <th className="py-2 px-2 font-medium">
                          {t("audit.ipAddress") || "IP"}
                        </th>
                        <th className="py-2 px-2 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr
                          key={r.id}
                          className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                          onClick={() => openDetail(r.id)}
                          data-testid="audit-row"
                          data-audit-id={r.id}
                        >
                          <td className="py-2 px-2 whitespace-nowrap">
                            {fmtDate(r.createdAt, getDateLocale())}
                          </td>
                          <td className="py-2 px-2 font-mono text-xs">
                            <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                              {r.action}
                            </span>
                          </td>
                          <td className="py-2 px-2">{r.entityType ?? "—"}</td>
                          <td className="py-2 px-2 text-xs">
                            {r.userEmail || r.userId || "—"}
                          </td>
                          <td className="py-2 px-2 font-mono text-xs">
                            {r.ipAddress ?? "—"}
                          </td>
                          <td className="py-2 px-2 text-right text-gray-500">
                            →
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Pagination */}
                <div className="flex items-center justify-between mt-4 text-sm">
                  <span className="text-gray-600 dark:text-gray-300">
                    {skip + 1}–{Math.min(skip + TAKE, total)} / {total}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSkip(Math.max(0, skip - TAKE))}
                      disabled={skip === 0}
                      data-testid="audit-prev"
                    >
                      ← {t("common.previous") || "Zurück"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSkip(skip + TAKE)}
                      disabled={!hasMore}
                      data-testid="audit-next"
                    >
                      {t("common.next") || "Weiter"} →
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Detail modal */}
      {(detail || loadingDetail) && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={closeDetail}
          data-testid="audit-detail-modal"
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-5xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  {t("audit.detailTitle") || "Änderung im Detail"}
                </h2>
                {detail && (
                  <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                    <span className="font-mono">{detail.action}</span> ·{" "}
                    {detail.entityType} · {fmtDate(detail.createdAt, getDateLocale())}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={closeDetail}
                data-testid="audit-detail-close"
              >
                ✕
              </Button>
            </div>
            <div className="p-6">
              {loadingDetail || !detail ? (
                <div className="text-center py-12 text-gray-500">
                  {t("common.loading") || "Wird geladen…"}
                </div>
              ) : (
                <>
                  <div className="mb-4 text-sm grid grid-cols-2 gap-2 text-gray-700 dark:text-gray-300">
                    <div>
                      <span className="text-gray-500">{t("audit.user") || "Benutzer"}:</span>{" "}
                      <span className="font-mono">{detail.userEmail || detail.userId || "—"}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">IP:</span>{" "}
                      <span className="font-mono">{detail.ipAddress || "—"}</span>
                    </div>
                    {detail.entityId && (
                      <div className="col-span-2">
                        <span className="text-gray-500">Entity-ID:</span>{" "}
                        <span className="font-mono text-xs">{detail.entityId}</span>
                      </div>
                    )}
                    {detail.userAgent && (
                      <div className="col-span-2 text-xs text-gray-500">
                        <span className="text-gray-500">User-Agent:</span> {detail.userAgent}
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <h3 className="text-sm font-semibold mb-2 text-red-700 dark:text-red-400">
                        {t("audit.oldData") || "Vorher"}
                      </h3>
                      <pre
                        className="bg-red-50 dark:bg-red-900/20 p-3 rounded text-xs overflow-x-auto border border-red-200 dark:border-red-800"
                        data-testid="audit-old-data"
                      >
                        {detail.oldData
                          ? JSON.stringify(detail.oldData, null, 2)
                          : "—"}
                      </pre>
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold mb-2 text-emerald-700 dark:text-emerald-400">
                        {t("audit.newData") || "Nachher"}
                      </h3>
                      <pre
                        className="bg-emerald-50 dark:bg-emerald-900/20 p-3 rounded text-xs overflow-x-auto border border-emerald-200 dark:border-emerald-800"
                        data-testid="audit-new-data"
                      >
                        {detail.newData
                          ? JSON.stringify(detail.newData, null, 2)
                          : "—"}
                      </pre>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
