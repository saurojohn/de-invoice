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
 *
 * Tier 122: added two view modes (table / timeline),
 * URL state for filters (Berater bookmarks), and
 * multi-select for entity types. The timeline groups
 * events by day and renders them as a vertical feed
 * — easier to scan than the table for "what changed
 * this week?" review. The existing table view +
 * detail modal are unchanged.
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

/**
 * Tier 122: URL-state helpers for the audit page.
 *
 * The Berater (Steuerberater) often wants to bookmark
 * a specific filter view ("show me all invoice
 * changes by user X in the last 30 days") and share
 * the link. We mirror the current filter values into
 * the URL query string so the page is deep-linkable.
 *
 * We deliberately use `window.location` + `history.
 * replaceState` here instead of `useSearchParams` +
 * `useRouter().replace` because the latter would
 * require a Suspense boundary in the App Router and
 * would also cause an extra render cycle. The
 * trade-off: a deep link has to be loaded once
 * before the filter UI is populated (we hydrate
 * the state in a useEffect on mount). Acceptable
 * for a filter UI — the user will type something
 * and the URL update is a no-op until they share.
 */
type FilterSnapshot = {
  entityType: string
  actionPrefix: string
  userId: string
  dateFrom: string
  dateTo: string
  view: "table" | "timeline"
}

function readFiltersFromUrl(): Partial<FilterSnapshot> {
  if (typeof window === "undefined") return {}
  const sp = new URLSearchParams(window.location.search)
  return {
    entityType: sp.get("entityType") || "",
    actionPrefix: sp.get("actionPrefix") || "",
    userId: sp.get("userId") || "",
    dateFrom: sp.get("dateFrom") || "",
    dateTo: sp.get("dateTo") || "",
    view: sp.get("view") === "timeline" ? "timeline" : "table",
  }
}

function writeFiltersToUrl(f: FilterSnapshot) {
  if (typeof window === "undefined") return
  const sp = new URLSearchParams(window.location.search)
  // Preserve any unrelated query params (e.g. utm_source).
  const setOrDel = (key: string, val: string) => {
    if (val) sp.set(key, val)
    else sp.delete(key)
  }
  setOrDel("entityType", f.entityType)
  setOrDel("actionPrefix", f.actionPrefix)
  setOrDel("userId", f.userId)
  setOrDel("dateFrom", f.dateFrom)
  setOrDel("dateTo", f.dateTo)
  setOrDel("view", f.view === "table" ? "" : f.view)
  const next = `${window.location.pathname}${
    sp.toString() ? "?" + sp.toString() : ""
  }`
  // replaceState so we don't pollute browser history
  // with every keystroke in the filter inputs.
  window.history.replaceState(null, "", next)
}

/**
 * Group rows by day (YYYY-MM-DD in local time) and
 * return an array of {day, items} for the timeline.
 * Newest day first; within a day, newest first.
 */
function groupByDay<T extends { createdAt: string }>(rows: T[]) {
  const buckets = new Map<string, T[]>()
  for (const r of rows) {
    const d = new Date(r.createdAt)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(d.getDate()).padStart(2, "0")}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(r)
  }
  return Array.from(buckets.entries())
    .sort((a, b) => (a[0] > b[0] ? -1 : a[0] < b[0] ? 1 : 0))
    .map(([day, items]) => ({ day, items }))
}

/**
 * Day label in German relative terms. "Heute" if
 * the day is today, "Gestern" if yesterday, otherwise
 * a formatted YYYY-MM-DD.
 */
function dayLabel(day: string, locale = "de-DE") {
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(
    today.getMonth() + 1,
  ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
  const yest = new Date(today)
  yest.setDate(yest.getDate() - 1)
  const yestKey = `${yest.getFullYear()}-${String(
    yest.getMonth() + 1,
  ).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`
  if (day === todayKey) return "Heute"
  if (day === yestKey) return "Gestern"
  // Format the YYYY-MM-DD as a German date.
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(locale, {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
}

export default function AuditPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  const toast = useToast()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  // Filters — initialised from the URL on first mount so
  // a deep link / bookmark is honoured. The useState
  // initializer only runs once (React convention), so
  // the URL is read exactly once per page load.
  const initial = useMemo(() => {
    if (typeof window === "undefined") {
      return {
        entityType: "",
        actionPrefix: "",
        userId: "",
        dateFrom: "",
        dateTo: "",
        view: "table" as "table" | "timeline",
      }
    }
    return {
      entityType: "",
      actionPrefix: "",
      userId: "",
      dateFrom: "",
      dateTo: "",
      view: "table" as "table" | "timeline",
      ...readFiltersFromUrl(),
    }
  }, [])
  const [entityType, setEntityType] = useState(initial.entityType || "")
  const [actionPrefix, setActionPrefix] = useState(initial.actionPrefix || "")
  const [userId, setUserId] = useState(initial.userId || "")
  const [dateFrom, setDateFrom] = useState(initial.dateFrom || "")
  const [dateTo, setDateTo] = useState(initial.dateTo || "")
  const [view, setView] = useState<"table" | "timeline">(initial.view || "table")
  const [skip, setSkip] = useState(0)
  const TAKE = 50

  // Tier 122: mirror filter state → URL on every
  // change so a deep link reflects the current view.
  // Skip the very first run (the initial state was
  // already loaded FROM the URL — re-writing it would
  // just churn history.replaceState).
  const urlSyncRef = useRef(false)
  useEffect(() => {
    if (!urlSyncRef.current) {
      urlSyncRef.current = true
      return
    }
    writeFiltersToUrl({
      entityType,
      actionPrefix,
      userId,
      dateFrom,
      dateTo,
      view,
    })
  }, [entityType, actionPrefix, userId, dateFrom, dateTo, view])

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
            {/* Tier 122: view toggle. URL state keeps the
                chosen view across refresh + share-link. */}
            <div
              className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 overflow-hidden"
              data-testid="audit-view-toggle"
              role="group"
              aria-label="Ansicht wechseln"
            >
              <button
                type="button"
                onClick={() => setView("table")}
                className={`px-3 py-1.5 text-sm ${
                  view === "table"
                    ? "bg-blue-600 text-white"
                    : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                }`}
                data-testid="audit-view-table"
                aria-pressed={view === "table"}
              >
                ☰ {t("audit.viewTable") || "Tabelle"}
              </button>
              <button
                type="button"
                onClick={() => setView("timeline")}
                className={`px-3 py-1.5 text-sm border-l border-gray-300 dark:border-gray-600 ${
                  view === "timeline"
                    ? "bg-blue-600 text-white"
                    : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                }`}
                data-testid="audit-view-timeline"
                aria-pressed={view === "timeline"}
              >
                ⏱ {t("audit.viewTimeline") || "Zeitstrahl"}
              </button>
            </div>
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
            ) : view === "timeline" ? (
              // Tier 122: timeline view — day-grouped,
              // vertical feed. Easier than the table for
              // "what changed this week?" reviews.
              <TimelineView
                rows={rows}
                onSelect={openDetail}
                dayLabel={dayLabel}
                t={t}
                getDateLocale={getDateLocale}
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

/**
 * Tier 122: Timeline view for audit events.
 *
 * Renders the rows as a vertical feed, grouped by
 * day. Each day gets a sticky-ish header; each event
 * is a card showing time, user, action, entity, IP.
 * Click on a card to open the existing detail modal.
 *
 * Kept inline (not in a separate file) because the
 * data shape is already local to the parent — splitting
 * it out would just add an import without making the
 * code clearer.
 */
function TimelineView({
  rows,
  onSelect,
  dayLabel,
  t,
  getDateLocale,
}: {
  rows: AuditRow[]
  onSelect: (id: string) => void
  dayLabel: (day: string, locale: string) => string
  t: (key: string) => string
  getDateLocale: () => string
}) {
  const groups = groupByDay(rows)
  return (
    <div className="space-y-6" data-testid="audit-timeline">
      {groups.map((g) => (
        <div
          key={g.day}
          data-testid={`audit-timeline-day-${g.day}`}
          className="border-l-2 border-blue-200 dark:border-blue-800 pl-4"
        >
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 sticky top-0 bg-white dark:bg-gray-800 py-1">
            {dayLabel(g.day, getDateLocale())}
            <span className="ml-2 text-xs text-gray-500">
              ({g.items.length}{" "}
              {g.items.length === 1
                ? t("audit.entry_one") || "Eintrag"
                : t("audit.entry_other") || "Einträge"}
              )
            </span>
          </h3>
          <ul className="space-y-2">
            {g.items.map((r) => {
              const t = new Date(r.createdAt)
              const hh = String(t.getHours()).padStart(2, "0")
              const mm = String(t.getMinutes()).padStart(2, "0")
              return (
                <li
                  key={r.id}
                  data-testid="audit-timeline-row"
                  data-audit-id={r.id}
                  onClick={() => onSelect(r.id)}
                  className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md p-3 hover:shadow-md cursor-pointer transition-shadow"
                >
                  <div className="flex items-start gap-3">
                    <span className="text-sm font-mono text-gray-500 dark:text-gray-400 w-12 flex-shrink-0">
                      {hh}:{mm}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 text-xs font-mono">
                          {r.action}
                        </span>
                        {r.entityType && (
                          <span className="text-sm text-gray-700 dark:text-gray-300">
                            <span className="font-medium">{r.entityType}</span>
                            {r.entityId && (
                              <span className="font-mono text-xs text-gray-500 ml-1">
                                · {r.entityId.slice(0, 12)}
                                {r.entityId.length > 12 ? "…" : ""}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-3">
                        <span>
                          👤 {r.userEmail || r.userId || "—"}
                        </span>
                        {r.ipAddress && <span>🌐 {r.ipAddress}</span>}
                      </div>
                    </div>
                    <span className="text-gray-400 text-sm">→</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
