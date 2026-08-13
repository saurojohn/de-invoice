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
  actionPrefix: string          // legacy single prefix (kept for back-compat with old URLs)
  actionPrefixes: string[]      // Tier 135: multi-select action prefixes (OR semantics)
  userId: string
  q: string                     // Tier 143: free-text search
  dateFrom: string
  dateTo: string
  view: "table" | "timeline"
}

function readFiltersFromUrl(): Partial<FilterSnapshot> {
  if (typeof window === "undefined") return {}
  const sp = new URLSearchParams(window.location.search)
  // Tier 135: read multi-select actionPrefixes (comma-separated)
  // or fall back to the legacy single actionPrefix. Whichever
  // is present wins. We DON'T merge them — a deep link with both
  // is treated as the multi-select value (URLs from old code
  // only have actionPrefix, so they get migrated naturally).
  let prefixes: string[] = []
  const apx = sp.get("actionPrefixes")
  if (apx) {
    prefixes = apx.split(",").map((s) => s.trim()).filter(Boolean)
  } else {    const ap = sp.get("actionPrefix")
    if (ap) prefixes = [ap]
  }
  return {
    entityType: sp.get("entityType") || "",
    actionPrefix: prefixes[0] || "",
    actionPrefixes: prefixes,
    userId: sp.get("userId") || "",
    q: sp.get("q") || "",
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
  // Tier 135: prefer the multi-select param. If exactly one
  // prefix is selected, also write to the legacy `actionPrefix`
  // so old bookmarks that read actionPrefix still work.
  setOrDel("actionPrefixes", f.actionPrefixes.join(","))
  setOrDel("actionPrefix", f.actionPrefixes.length === 1 ? f.actionPrefixes[0] : "")
  setOrDel("userId", f.userId)
  setOrDel("q", f.q)
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
        actionPrefixes: [] as string[],
        userId: "",
        q: "",
        dateFrom: "",
        dateTo: "",
        view: "table" as "table" | "timeline",
      }
    }
    return {
      entityType: "",
      actionPrefix: "",
      actionPrefixes: [] as string[],
      userId: "",
      q: "",
      dateFrom: "",
      dateTo: "",
      view: "table" as "table" | "timeline",
      ...readFiltersFromUrl(),
    }
  }, [])
  const [entityType, setEntityType] = useState(initial.entityType || "")
  const [actionPrefix, setActionPrefix] = useState(initial.actionPrefix || "")
  // Tier 135: multi-select action prefixes (replaces
  // the legacy single-string actionPrefix in the UI).
  // The two are kept in sync: actionPrefix is the
  // legacy single string for back-compat reads.
  const [actionPrefixes, setActionPrefixes] = useState<string[]>(
    initial.actionPrefixes || (initial.actionPrefix ? [initial.actionPrefix] : []),
  )
  const [userId, setUserId] = useState(initial.userId || "")
  // Tier 143: free-text search. Debounced 300ms so we
  // don't refetch on every keystroke when the user is
  // typing a longer invoice number.
  const [q, setQ] = useState(initial.q || "")
  const [qDebounced, setQDebounced] = useState(initial.q || "")
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 300)
    return () => clearTimeout(t)
  }, [q])
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
      actionPrefix: actionPrefixes[0] || "",
      actionPrefixes,
      userId,
      q,
      dateFrom,
      dateTo,
      view,
    })
  }, [entityType, actionPrefixes, userId, q, dateFrom, dateTo, view])

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
      // Tier 135: prefer the multi-select param. Falls back
      // to the legacy single actionPrefix if no multi-set.
      if (actionPrefixes.length > 0) {
        params.set("actionPrefixes", actionPrefixes.join(","))
      } else if (actionPrefix) {
        params.set("actionPrefix", actionPrefix)
      }
      if (userId) params.set("userId", userId)
      // Tier 143: free-text search. Send the
      // DEBOUNCED value so the URL state matches
      // what the API actually queried (the raw `q`
      // might still be mid-typing).
      if (qDebounced) params.set("q", qDebounced)
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
  }, [companyId, entityType, actionPrefix, actionPrefixes, userId, qDebounced, dateFrom, dateTo, skip])

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
    setActionPrefixes([])
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

  // Tier 135: derive the list of action-prefix
  // chips from `stats.byAction`. We group by the
  // prefix (everything before the last ".") so a
  // chip like "invoice." subsumes "invoice.created"
  // + "invoice.updated" + "invoice.deleted" +
  // anything else under the same domain. Counts are
  // summed so the chip shows the total volume under
  // that prefix. The chip list is sorted by count
  // desc so the highest-traffic actions are first.
  const actionPrefixChips = useMemo(() => {
    const map = new Map<string, number>()
    stats?.byAction.forEach((b) => {
      if (!b.action) return
      // Find the last "." — everything before it is
      // the "domain" (invoice, customer, payment, …).
      // For actions without a dot (e.g. "LOGIN") we
      // use the whole action as the chip key so they
      // still appear in the list.
      const lastDot = b.action.lastIndexOf(".")
      const prefix = lastDot > 0 ? b.action.slice(0, lastDot + 1) : b.action
      map.set(prefix, (map.get(prefix) || 0) + b.count)
    })
    return Array.from(map.entries())
      .map(([prefix, count]) => ({ prefix, count }))
      .sort((a, b) => b.count - a.count)
  }, [stats])

  // Quick date preset: fill dateFrom/dateTo from a
  // human-friendly label. "Heute" = today, "7 Tage"
  // = last 7 days incl today, "30 Tage" = last 30
  // days, "Quartal" = current calendar quarter
  // (Jan-Mar / Apr-Jun / Jul-Sep / Oct-Dec), "Leer"
  // = clear both. Returns ISO yyyy-mm-dd for the
  // <input type="date"> fields.
  const applyDatePreset = (preset: "today" | "7d" | "30d" | "quarter" | "clear") => {
    const today = new Date()
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`
    if (preset === "clear") {
      setDateFrom("")
      setDateTo("")
      setSkip(0)
      return
    }
    if (preset === "today") {
      setDateFrom(fmt(today))
      setDateTo(fmt(today))
    } else if (preset === "7d") {
      const from = new Date(today)
      from.setDate(from.getDate() - 6)
      setDateFrom(fmt(from))
      setDateTo(fmt(today))
    } else if (preset === "30d") {
      const from = new Date(today)
      from.setDate(from.getDate() - 29)
      setDateFrom(fmt(from))
      setDateTo(fmt(today))
    } else if (preset === "quarter") {
      // Calendar quarter: Q1=Jan-Mar, Q2=Apr-Jun, …
      const q = Math.floor(today.getMonth() / 3)
      const from = new Date(today.getFullYear(), q * 3, 1)
      const to = new Date(today.getFullYear(), q * 3 + 3, 0)
      setDateFrom(fmt(from))
      setDateTo(fmt(to))
    }
    setSkip(0)
  }

  const exportCsvUrl = useMemo(() => {
    if (!companyId) return "#"
    const params = new URLSearchParams()
    params.set("companyId", companyId)
    if (entityType) params.set("entityType", entityType)
    if (actionPrefixes.length > 0) {
      params.set("actionPrefixes", actionPrefixes.join(","))
    } else if (actionPrefix) {
      params.set("actionPrefix", actionPrefix)
    }
    if (userId) params.set("userId", userId)
    if (qDebounced) params.set("q", qDebounced)
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
  }, [companyId, entityType, actionPrefix, actionPrefixes, userId, qDebounced, dateFrom, dateTo])

  const downloadCsv = async () => {
    if (!companyId) return
    try {
      const params = new URLSearchParams()
      params.set("companyId", companyId)
      if (entityType) params.set("entityType", entityType)
      if (actionPrefixes.length > 0) {
        params.set("actionPrefixes", actionPrefixes.join(","))
      } else if (actionPrefix) {
        params.set("actionPrefix", actionPrefix)
      }
      if (userId) params.set("userId", userId)
      if (qDebounced) params.set("q", qDebounced)
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

  // Tier 166: GoBD archive download. The
  // button reads the year from the year
  // picker; we pass it as ?year=YYYY. The
  // response is application/zip with a
  // Content-Disposition filename and an
  // X-GoBD-Stats header carrying the
  // per-section counts. We read the stats
  // header BEFORE the body is consumed, so
  // the toast can show "12 invoices, 2
  // Mahnungen, 70 emails, 92 audit rows,
  // 55.8 KB" — useful feedback that the
  // archive actually contains data.
  const downloadGobdArchive = async () => {
    const companyId =
      typeof window !== "undefined"
        ? localStorage.getItem("companyId")
        : null
    if (!companyId) {
      toast.error(t("common.companyMissing") || "companyId fehlt")
      return
    }
    const sel = document.querySelector(
      '[data-testid="audit-gobd-year"]',
    ) as HTMLSelectElement | null
    const year = sel?.value || String(new Date().getFullYear())
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    try {
      const res = await fetch(
        `${apiBase}/api/v1/gobd-export?companyId=${companyId}&year=${year}`,
        {
          headers: {
            "x-user-id":
              localStorage.getItem("userId") || "",
            "x-company-id": companyId,
          },
        },
      )
      if (!res.ok) {
        toast.error(
          `GoBD-Archiv: HTTP ${res.status}`,
        )
        return
      }
      // Pull the X-GoBD-Stats header so the
      // user sees "what's inside" the
      // archive without unzipping. The
      // header is a JSON string; we
      // JSON.parse it for the toast.
      const statsHeader = res.headers.get("x-gobd-stats")
      let statsText = ""
      if (statsHeader) {
        try {
          const s = JSON.parse(statsHeader)
          statsText = ` — ${s.invoices} Rechnungen, ${s.mahnungen} Mahnungen, ${s.emailSends} E-Mails, ${s.auditLogRows} Audit-Einträge`
        } catch {
          // statsHeader wasn't JSON — fall
          // back to a generic message
        }
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      // Filename comes from the
      // Content-Disposition header; the
      // backend sets it to
      // GoBD-YYYY-CompanyName-YYYY-MM-DD.zip
      const cd = res.headers.get("content-disposition") || ""
      const m = cd.match(/filename="([^"]+)"/)
      a.download = m?.[1] || `GoBD-${year}.zip`
      a.href = url
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success(
        `${t("audit.gobdExportOk") || "GoBD-Archiv heruntergeladen"}${statsText}`,
      )
    } catch (e: any) {
      toast.error(e?.message || t("common.loadError"))
    }
  }

  // Tier 183: month-scoped GoBD archive
  // download. Same pattern as the year
  // button (Tier 166), but with an extra
  // `&month=N` query param that the
  // backend (Tier 181) accepts. The
  // Berater picks a year + month and gets
  // back a single-month archive.
  const downloadGobdMonth = async () => {
    const companyId =
      typeof window !== "undefined"
        ? localStorage.getItem("companyId")
        : null
    if (!companyId) {
      toast.error(t("common.companyMissing") || "companyId fehlt")
      return
    }
    const yearSel = document.querySelector(
      '[data-testid="audit-gobd-year"]',
    ) as HTMLSelectElement | null
    const monthSel = document.querySelector(
      '[data-testid="audit-gobd-month"]',
    ) as HTMLSelectElement | null
    const year = yearSel?.value || String(new Date().getFullYear())
    const month = parseInt(monthSel?.value || "1", 10)
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      toast.error(
        t("audit.invalidMonth") || "Ungültiger Monat (1-12)",
      )
      return
    }
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    try {
      const res = await fetch(
        `${apiBase}/api/v1/gobd-export?companyId=${companyId}&year=${year}&month=${month}`,
        {
          headers: {
            "x-user-id":
              localStorage.getItem("userId") || "",
            "x-company-id": companyId,
          },
        },
      )
      if (!res.ok) {
        const errText = await res.text().catch(() => "")
        toast.error(
          `GoBD-Monats-Archiv: HTTP ${res.status} — ${errText.slice(0, 200)}`,
        )
        return
      }
      const statsHeader = res.headers.get("x-gobd-stats")
      let statsText = ""
      if (statsHeader) {
        try {
          const s = JSON.parse(statsHeader)
          statsText = ` — ${s.invoices} Rechnungen, ${s.mahnungen} Mahnungen, ${s.emailSends} E-Mails, ${s.auditLogRows} Audit-Einträge`
        } catch {
          // statsHeader wasn't JSON
        }
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      const cd = res.headers.get("content-disposition") || ""
      const m = cd.match(/filename="([^"]+)"/)
      a.download =
        m?.[1] ||
        `GoBD-${year}-${String(month).padStart(2, "0")}.zip`
      a.href = url
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success(
        `${t("audit.gobdMonthExportOk") || "GoBD-Monats-Archiv heruntergeladen"}${statsText}`,
      )
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
            {/* Tier 166: GoBD § 147 AO archive
                export. Year picker defaults to
                the current year; the button
                triggers a fetch + browser
                download of the ZIP. The
                X-GoBD-Stats header is read via
                fetch + the size is shown in a
                toast so the user knows the
                export succeeded without
                unzipping. */}
            <select
              data-testid="audit-gobd-year"
              defaultValue={new Date().getFullYear()}
              className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
              aria-label="GoBD-Archiv Jahr"
            >
              {Array.from({ length: 11 }, (_, i) => {
                const y = new Date().getFullYear() - i
                return (
                  <option key={y} value={y}>
                    {y}
                  </option>
                )
              })}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadGobdArchive}
              data-testid="audit-export-gobd"
            >
              🗄 {t("audit.exportGobd") || "GoBD-Archiv"}
            </Button>
            {/* Tier 183: month-scoped GoBD archive
                download. The month picker sits next
                to the year picker, and the "Monats-Archiv"
                button triggers a single-month pack
                via ?year=&month= (Tier 181 backend). */}
            <select
              data-testid="audit-gobd-month"
              defaultValue={new Date().getMonth() + 1}
              className="px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
              aria-label={t("audit.gobdMonthPickerLabel") || "Monat"}
            >
              {[
                "01 — Januar",
                "02 — Februar",
                "03 — März",
                "04 — April",
                "05 — Mai",
                "06 — Juni",
                "07 — Juli",
                "08 — August",
                "09 — September",
                "10 — Oktober",
                "11 — November",
                "12 — Dezember",
              ].map((label, i) => (
                <option key={i + 1} value={i + 1}>
                  {label}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadGobdMonth}
              data-testid="audit-export-gobd-month"
            >
              🗓 {t("audit.exportGobdMonth") || "GoBD-Monats-Archiv"}
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
            {/* Tier 143: free-text search. Full-width above
                the other filters so it's the most visible
                input — the Berater's primary use case is
                "find the row about invoice INV-2026-000203",
                not "filter by exact entity type". */}
            <div className="mb-4">
              <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                {t("audit.searchLabel") || "Volltext-Suche"}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                  🔍
                </span>
                <input
                  type="text"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value)
                    setSkip(0)
                  }}
                  placeholder={
                    t("audit.searchPlaceholder") ||
                    "Rechnungsnummer, Kunde, Benutzer, Aktion…"
                  }
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-sm"
                  data-testid="audit-filter-q"
                />
                {q && (
                  <button
                    onClick={() => {
                      setQ("")
                      setSkip(0)
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm"
                    data-testid="audit-filter-q-clear"
                    aria-label="Suche löschen"
                  >
                    ✕
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {t("audit.searchHint") ||
                  "Durchsucht Aktion, Entitätstyp, Benutzer-E-Mail und JSON-Inhalte (Rechnungsnummer, Kundenname, etc.)."}
              </p>
            </div>
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
              <div className="md:col-span-3">
                <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                  {t("audit.actionPrefix") || "Aktion (Präfix)"}
                </label>
                {/* Tier 135: action chips. Each chip
                    represents a prefix group (e.g.
                    "invoice.") and selecting it adds
                    that prefix to the filter (OR
                    semantics across selected chips).
                    Sourced from stats.byAction so the
                    chips only show prefixes that
                    actually have rows in the DB. */}
                <div
                  className="flex flex-wrap gap-1.5"
                  data-testid="audit-filter-action-chips"
                >
                  {actionPrefixChips.length === 0 ? (
                    <span className="text-xs text-gray-400 italic">
                      —
                    </span>
                  ) : (
                    actionPrefixChips.map((c) => {
                      const active = actionPrefixes.includes(c.prefix)
                      return (
                        <button
                          key={c.prefix}
                          type="button"
                          onClick={() => {
                            if (active) {
                              setActionPrefixes(
                                actionPrefixes.filter((p) => p !== c.prefix),
                              )
                            } else {
                              setActionPrefixes([...actionPrefixes, c.prefix])
                            }
                            setSkip(0)
                          }}
                          className={`text-xs px-2.5 py-1 rounded-full border transition ${
                            active
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                          }`}
                          data-testid={`audit-action-chip-${c.prefix.replace(/\W/g, "_")}`}
                          aria-pressed={active}
                        >
                          {c.prefix}{" "}
                          <span
                            className={
                              active
                                ? "text-blue-100"
                                : "text-gray-400"
                            }
                          >
                            ({c.count})
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
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
              <div className="md:col-span-3">
                {/* Tier 135: quick date presets. Common
                    auditor workflows (this quarter for
                    UStVA prep, last 30 days for a
                    monthly review) become a single
                    click. Each button auto-fills
                    dateFrom/dateTo and triggers a
                    re-fetch. "Eigener Zeitraum" is
                    implicit — the two date inputs above
                    still work for custom ranges. */}
                <div
                  className="flex flex-wrap gap-1.5"
                  data-testid="audit-filter-date-presets"
                >
                  <button
                    type="button"
                    onClick={() => applyDatePreset("today")}
                    className="text-xs px-2.5 py-1 rounded-full border bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                    data-testid="audit-date-preset-today"
                  >
                    📅 {t("audit.presetToday") || "Heute"}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyDatePreset("7d")}
                    className="text-xs px-2.5 py-1 rounded-full border bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                    data-testid="audit-date-preset-7d"
                  >
                    7 {t("audit.presetDays") || "Tage"}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyDatePreset("30d")}
                    className="text-xs px-2.5 py-1 rounded-full border bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                    data-testid="audit-date-preset-30d"
                  >
                    30 {t("audit.presetDays") || "Tage"}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyDatePreset("quarter")}
                    className="text-xs px-2.5 py-1 rounded-full border bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                    data-testid="audit-date-preset-quarter"
                  >
                    📊 {t("audit.presetQuarter") || "Quartal"}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyDatePreset("clear")}
                    className="text-xs px-2.5 py-1 rounded-full border bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                    data-testid="audit-date-preset-clear"
                  >
                    ↺ {t("audit.presetClear") || "Zeitraum löschen"}
                  </button>
                </div>
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
