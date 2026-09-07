"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { SkeletonTable } from "@/components/ui/skeleton"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiPut } from "@/lib/api"

interface ErrorEvent {
  id: string
  source: "backend" | "frontend"
  kind: string
  message: string
  stack: string | null
  context: any
  occurrences: number
  status: "open" | "resolved" | "muted"
  fingerprint: string
  url: string | null
  method: string | null
  statusCode: number | null
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  resolvedBy: string | null
}

type StatusFilter = "open" | "resolved" | "muted" | "all"
type SourceFilter = "all" | "backend" | "frontend"

interface NotificationConfig {
  slack: { configured: boolean; host: string | null }
  email: {
    configured: boolean
    recipients: string[]
    smtpHost: string | null
  }
  antiSpamMinutes: number
}

// Tier 205 — rate-threshold shape for the
// push channels. A fingerprint must be
// seen `rateThresholdCount` times within
// `rateThresholdWindowMinutes` minutes
// before the push fires. Default 5/60
// (= "5 in an hour, then ping on-call").
interface NotificationThreshold {
  rateThresholdCount: number
  rateThresholdWindowMinutes: number
  note?: string | null
  updatedAt?: string
}

// Tier 200 — per-day timeline bucket
// for the system-errors bar chart. The
// `date` is an ISO date string
// (YYYY-MM-DD) so we can format it with
// toLocaleDateString for the x-axis
// labels. Counts are by current status
// (not historical), so a row that's
// been resolved counts as "resolved" in
// its creation day.
interface TimelineBucket {
  date: string
  total: number
  open: number
  resolved: number
  muted: number
}

interface TimelineResponse {
  days: number
  source: "all" | "backend" | "frontend"
  buckets: TimelineBucket[]
  totals: { open: number; resolved: number; muted: number }
}

// Tier 200 — inline stacked bar chart
// for the 30-day timeline. No chart
// library (recharts/chart.js would be
// ~50KB+ for 30 bars × 3 series).
// Implementation:
//   - One <rect> per day, 3 segments
//     (open / resolved / muted) stacked
//     bottom-up.
//   - Width 100% via viewBox 0..300,
//     10px per day × 30 days = 300px
//     wide. Height fixed 80px.
//   - X-axis labels: every 5th day to
//     avoid clutter.
//   - Hover (title element) shows the
//     exact counts per day.
// Why SVG and not a CSS bar chart?
//   - The x-axis labels need the
//     current locale date format.
//     HTML/CSS can't render text
//     inside a <div> column chart
//     without an extra wrapper per
//     tick.
//   - 30 days × 3 stacked segments =
//     90 rects. SVG handles this fine
//     on any browser.
function TimelineChart({
  buckets,
  t,
  locale,
}: {
  buckets: TimelineBucket[]
  t: (key: string, vars?: Record<string, string>) => string
  locale: string
}) {
  const W = 300
  const H = 80
  const BAR_WIDTH = (W - 4) / 30
  const GAP = 0.5
  // Find max stacked total for y-scale.
  const maxTotal = Math.max(1, ...buckets.map((b) => b.total))
  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(locale, {
        day: "2-digit",
        month: "2-digit",
      })
    } catch {
      return iso
    }
  }
  if (buckets.every((b) => b.total === 0)) {
    return (
      <div
        className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center"
        data-testid="timeline-empty"
      >
        {t("systemErrors.timeline.empty")}
      </div>
    )
  }
  return (
    <div data-testid="timeline-chart" className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H + 16}`}
        width="100%"
        height={H + 16}
        preserveAspectRatio="none"
        className="block"
        role="img"
        aria-label={t("systemErrors.timeline.title")}
      >
        {buckets.map((b, i) => {
          const x = i * BAR_WIDTH + GAP
          const totalH = (b.total / maxTotal) * H
          const openH = (b.open / maxTotal) * H
          const resolvedH = (b.resolved / maxTotal) * H
          const mutedH = (b.muted / maxTotal) * H
          // Stacked bottom-up: muted (bottom)
          // → resolved → open (top)
          const mutedY = H - mutedH
          const resolvedY = mutedY - resolvedH
          const openY = resolvedY - openH
          return (
            <g key={b.date} data-testid="timeline-day">
              <title>
                {fmtDate(b.date)}: {t("systemErrors.timeline.legendOpen")} {b.open},{" "}
                {t("systemErrors.timeline.legendResolved")} {b.resolved},{" "}
                {t("systemErrors.timeline.legendMuted")} {b.muted}
              </title>
              {totalH > 0 && (
                <>
                  <rect
                    x={x}
                    y={openY}
                    width={BAR_WIDTH - GAP * 2}
                    height={openH}
                    fill="#ef4444"
                  />
                  <rect
                    x={x}
                    y={resolvedY}
                    width={BAR_WIDTH - GAP * 2}
                    height={resolvedH}
                    fill="#10b981"
                  />
                  <rect
                    x={x}
                    y={mutedY}
                    width={BAR_WIDTH - GAP * 2}
                    height={mutedH}
                    fill="#9ca3af"
                  />
                </>
              )}
              {/* X-axis label every 5th day */}
              {i % 5 === 0 && (
                <text
                  x={x + (BAR_WIDTH - GAP * 2) / 2}
                  y={H + 12}
                  fontSize="7"
                  textAnchor="middle"
                  className="fill-gray-600 dark:fill-gray-400"
                >
                  {fmtDate(b.date)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export default function SystemErrorsPage() {
  const router = useRouter()
  const { t, getDateLocale, locale } = useI18n()
  const toast = useToast()
  const [events, setEvents] = useState<ErrorEvent[]>([])
  const [total, setTotal] = useState(0)
  const [openCount, setOpenCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open")
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Tier 197 — notification config + last test result.
  const [notifConfig, setNotifConfig] = useState<NotificationConfig | null>(null)
  const [lastTestResult, setLastTestResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Tier 205 — rate-threshold editor. The
  // form has 2 inputs (count + window) +
  // an optional note. We keep the working
  // copy in state so the operator can
  // adjust without committing until they
  // click "Speichern".
  const [threshold, setThreshold] = useState<NotificationThreshold | null>(null)
  const [thresholdDraft, setThresholdDraft] = useState<{
    count: string
    window: string
    note: string
  }>({ count: "", window: "", note: "" })
  const [thresholdSaving, setThresholdSaving] = useState(false)
  // Tier 206 — top-N fingerprints by
  // rate over the configured window.
  // Same shape as the backend's
  // `topRateFingerprints` response.
  interface TopRateRow {
    fingerprint: string
    fingerprintShort: string
    count: number
    threshold: number
    exceeded: boolean
    message: string | null
    source: string | null
    kind: string | null
    status: string | null
    lastSeenAt: string | null
    occurrences: number
  }
  interface TopRateResponse {
    windowMinutes: number
    threshold: number
    limit: number
    source: string
    rows: TopRateRow[]
  }
  const [topRate, setTopRate] = useState<TopRateResponse | null>(null)
  const [topRateLoading, setTopRateLoading] = useState(false)
  // Tier 200 — 30-day timeline. We keep
  // a separate state for the timeline
  // (and a separate fetch) because the
  // timeline shows data from a wider
  // window than the list (30 days vs
  // whatever statusFilter is set to).
  // The timeline's own source filter is
  // independent of the list's source
  // filter so the operator can see
  // "backend-only" health in the
  // timeline while still listing
  // frontend+backend errors below.
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineSource, setTimelineSource] = useState<"all" | "backend" | "frontend">("all")
  // local companyId for re-fetches
  // after bulk actions. Populated
  // from localStorage in the same
  // useEffect that does the initial
  // load.
  const [companyId, setCompanyId] = useState<string>("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== "all") params.set("status", statusFilter)
      if (sourceFilter !== "all") params.set("source", sourceFilter)
      params.set("take", "100")
      const data = await apiGet<{
        items: ErrorEvent[]
        total: number
        openCount: number
      }>(`/api/v1/system/errors?${params.toString()}`)
      setEvents(data.items)
      setTotal(data.total)
      setOpenCount(data.openCount)
    } catch (e: any) {
      toast.error(e.message || t("common.loadError"))
    } finally {
      setLoading(false)
    }
  }, [statusFilter, sourceFilter, t, toast])

  // Tier 200 — fetch the 30-day
  // timeline. The fetch is keyed on
  // timelineSource so the operator can
  // flip "All / Backend / Frontend"
  // without re-rendering the rest of
  // the page.
  const fetchTimeline = useCallback(
    async (cid: string, source: "all" | "backend" | "frontend") => {
      setTimelineLoading(true)
      try {
        const params = new URLSearchParams({ days: "30", companyId: cid })
        if (source !== "all") params.set("source", source)
        const data = await apiGet<TimelineResponse>(
          `/api/v1/system/errors/timeline?${params.toString()}`,
        )
        setTimeline(data)
      } catch {
        setTimeline(null)
      } finally {
        setTimelineLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    const cid = localStorage.getItem("companyId")
    if (!cid) {
      router.push("/login")
      return
    }
    setCompanyId(cid)
    load()
    // Tier 197 — load notification config in
    // parallel so the operator can see which
    // push channels are wired before triggering
    // a test. We fire-and-forget — the channel
    // card renders when the response lands.
    apiGet<NotificationConfig>("/api/v1/system/notifications/config")
      .then(setNotifConfig)
      .catch(() => setNotifConfig(null))
    // Tier 200 — load the 30-day timeline.
    fetchTimeline(cid, timelineSource)
     
  }, [load, router, fetchTimeline, timelineSource])

  // Tier 206 — load the top-N
  // fingerprints by rate. We use a
  // SEPARATE useEffect (not piggy-
  // backing on the main one above)
  // because `load` / `fetchTimeline`
  // re-allocate on every filter
  // change, which would re-fire
  // `fetchTopRate()` and keep the
  // refresh button in its loading
  // state forever. The []-deps
  // mount-only pattern is the same
  // one we use for the threshold
  // load (Tier 205). The user can
  // re-fetch manually via the
  // refresh button or via the
  // saveThreshold handler.
  useEffect(() => {
    fetchTopRate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tier 205 — load rate threshold ONCE on
  // mount. We use a separate useEffect (not
  // piggybacking on the one above) so the
  // threshold draft isn't reset every time
  // the timeline filter changes. Same
  // pattern as the activity page (Tier 202
  // fix) — `load` + `fetchTimeline` are
  // useCallbacks that get re-allocated on
  // every render, so depending on them in
  // the same effect would re-run the
  // threshold fetch on every render and
  // clobber the operator's in-flight draft.
  useEffect(() => {
    apiGet<NotificationThreshold>("/api/v1/system/notifications/threshold")
      .then((t) => {
        setThreshold(t)
        setThresholdDraft({
          count: String(t.rateThresholdCount),
          window: String(t.rateThresholdWindowMinutes),
          note: t.note ?? "",
        })
      })
      .catch(() => {
        // Show defaults so the form
        // is still usable. The PUT
        // will create the singleton
        // row on first save.
        const fallback = {
          rateThresholdCount: 5,
          rateThresholdWindowMinutes: 60,
        }
        setThreshold(fallback)
        setThresholdDraft({
          count: "5",
          window: "60",
          note: "",
        })
      })
     
  }, [])

  const resolve = async (id: string) => {
    try {
      await apiPost(`/api/v1/system/errors/${id}/resolve`)
      toast.success(t("systemErrors.resolved"))
      load()
      if (companyId) fetchTimeline(companyId, timelineSource)
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const mute = async (id: string) => {
    try {
      await apiPost(`/api/v1/system/errors/${id}/mute`)
      toast.success(t("systemErrors.muted"))
      load()
      if (companyId) fetchTimeline(companyId, timelineSource)
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const prune = async () => {
    if (!confirm(t("systemErrors.pruneConfirm", { n: String(openCount) }))) return
    try {
      const res = await apiPost<{ deleted: number }>("/api/v1/system/errors/prune")
      toast.success(t("systemErrors.pruned", { n: String(res.deleted) }))
      load()
      if (companyId) fetchTimeline(companyId, timelineSource)
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  // Tier 197 — bulk operations. Both endpoints
  // return {ok, count} so we can surface a precise
  // "X events updated" toast. We use a confirm()
  // guard for resolveAll (irreversible from the
  // operator's POV) but not for muteAll (reversible
  // by un-muting one at a time later if needed).
  const resolveAll = async () => {
    if (openCount === 0) return
    if (
      !confirm(
        t("systemErrors.resolveAllConfirm", { n: String(openCount) }),
      )
    )
      return
    setBusy(true)
    try {
      const res = await apiPost<{ ok: boolean; count: number }>(
        "/api/v1/system/errors/resolve-all",
      )
      toast.success(t("systemErrors.resolvedAll", { n: String(res.count) }))
      load()
      if (companyId) fetchTimeline(companyId, timelineSource)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const muteAll = async () => {
    if (openCount === 0) return
    setBusy(true)
    try {
      const res = await apiPost<{ ok: boolean; count: number }>(
        "/api/v1/system/errors/mute-all",
      )
      toast.success(t("systemErrors.mutedAll", { n: String(res.count) }))
      load()
      if (companyId) fetchTimeline(companyId, timelineSource)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Tier 197 — fire a synthetic notification through
  // the same push pipeline. Surfaces the per-channel
  // result so the operator can see "Slack: sent,
  // Email: skipped, Console: sent" without having
  // to dig through /tmp/backend.log.
  const testNotification = async () => {
    setBusy(true)
    try {
      const res = await apiPost<{
        slack: string
        email: string
        console: string
      }>("/api/v1/system/notifications/test")
      setLastTestResult(
        `${t("systemErrors.testResultSlack")}: ${res.slack} · ${t(
          "systemErrors.testResultEmail",
        )}: ${res.email} · ${t("systemErrors.testResultConsole")}: ${res.console}`,
      )
      toast.success(t("systemErrors.testFired"))
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Tier 205 — save the rate-threshold form.
  // The inputs are plain text (not <input
  // type=number>) so we can validate the
  // parsed value before sending + show the
  // 400 message from the backend. We don't
  // apply the new value to the working state
  // until the PUT succeeds (toast on success).
  const saveThreshold = async () => {
    const count = parseInt(thresholdDraft.count, 10)
    const window = parseInt(thresholdDraft.window, 10)
    if (!Number.isFinite(count) || count < 1 || count > 1000) {
      toast.error(t("systemErrors.thresholdInvalidCount"))
      return
    }
    if (!Number.isFinite(window) || window < 1 || window > 1440) {
      toast.error(t("systemErrors.thresholdInvalidWindow"))
      return
    }
    setThresholdSaving(true)
    try {
      const res = await apiPut<NotificationThreshold>(
        "/api/v1/system/notifications/threshold",
        {
          rateThresholdCount: count,
          rateThresholdWindowMinutes: window,
          note: thresholdDraft.note || undefined,
        },
      )
      setThreshold(res)
      toast.success(t("systemErrors.thresholdSaved"))
      // Tier 206 — re-fetch the top-rate
      // table so the operator sees the
      // effect of the new threshold
      // immediately (rows flip from
      // exceeded → ok or vice versa).
      fetchTopRate()
    } catch (e: any) {
      toast.error(e.message || t("systemErrors.thresholdSaveFailed"))
    } finally {
      setThresholdSaving(false)
    }
  }

  // Tier 206 — fetch the top-N fingerprints
  // by rate. Called on mount + on Refresh
  // click + after the threshold save
  // (above). Default limit=10 keeps the
  // table small; the operator can re-query
  // with a higher limit via the URL if
  // needed (out of scope for the UI for
  // Tier 206 — a limit selector can be
  // added later if the operator asks for
  // it).
  const fetchTopRate = useCallback(async () => {
    setTopRateLoading(true)
    try {
      const res = await apiGet<TopRateResponse>(
        "/api/v1/system/errors/top-rate?limit=10",
      )
      setTopRate(res)
    } catch (e: any) {
      // Don't toast on every refresh
      // — the table just shows the
      // stale data until next
      // refresh.
       
      console.warn("[tier206/top-rate] fetch failed:", e?.message)
    } finally {
      setTopRateLoading(false)
    }
  }, [])

  const fmt = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(getDateLocale())
    } catch {
      return iso
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {t("systemErrors.title")}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t("systemErrors.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="text-sm text-blue-600 hover:underline"
            >
              ← {t("nav.dashboard")}
            </Link>
            <LanguageSwitcher />
          </div>
        </div>

        {/* Tier 197 — notification channel status. Surfaces
            whether Slack / email are wired without exposing
            the webhook URL or SMTP password. Helps the
            operator understand why they didn't get a ping
            for a real error. */}
        {notifConfig && (
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3 text-sm flex-wrap">
                  <span className="font-semibold text-gray-700 dark:text-gray-300">
                    {t("systemErrors.notifChannels")}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                      notifConfig.slack.configured
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                        : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                    data-testid="notif-slack"
                  >
                    Slack:{" "}
                    {notifConfig.slack.configured
                      ? notifConfig.slack.host
                      : t("systemErrors.notifOff")}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                      notifConfig.email.configured
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                        : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                    data-testid="notif-email"
                  >
                    Email:{" "}
                    {notifConfig.email.configured
                      ? `${notifConfig.email.recipients.length} ${t("systemErrors.notifRecipients")}`
                      : t("systemErrors.notifOff")}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {t("systemErrors.notifAntiSpam", {
                      n: String(notifConfig.antiSpamMinutes),
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={testNotification}
                    disabled={busy}
                    data-testid="notif-test"
                  >
                    {t("systemErrors.testNotifications")}
                  </Button>
                </div>
              </div>
              {lastTestResult && (
                <p
                  className="mt-2 text-xs text-gray-600 dark:text-gray-400 font-mono"
                  data-testid="notif-test-result"
                >
                  {lastTestResult}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Tier 205 — rate-threshold config. The
            push channels (Slack / email) only fire
            when an error fingerprint is seen
            `rateThresholdCount` times within
            `rateThresholdWindowMinutes` minutes.
            Default 5/60. Lower it for noisy
            envs, raise it to suppress one-off
            alerts. Anti-spam window (5 min) is
            separate — that's the per-fingerprint
            throttle AFTER the rate gate lets
            something through. */}
        {threshold && (
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
                <div className="text-sm">
                  <span className="font-semibold text-gray-700 dark:text-gray-300">
                    {t("systemErrors.thresholdTitle")}
                  </span>
                  <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                    {t("systemErrors.thresholdCurrent", {
                      n: String(threshold.rateThresholdCount),
                      m: String(threshold.rateThresholdWindowMinutes),
                    })}
                  </span>
                </div>
              </div>
              <div className="flex items-end gap-3 flex-wrap text-sm">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                    {t("systemErrors.thresholdCount")}
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={thresholdDraft.count}
                    onChange={(e) =>
                      setThresholdDraft((d) => ({ ...d, count: e.target.value }))
                    }
                    disabled={thresholdSaving}
                    data-testid="threshold-count"
                    className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                    {t("systemErrors.thresholdWindow")}
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={thresholdDraft.window}
                    onChange={(e) =>
                      setThresholdDraft((d) => ({ ...d, window: e.target.value }))
                    }
                    disabled={thresholdSaving}
                    data-testid="threshold-window"
                    className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                    {t("systemErrors.thresholdNote")}
                  </label>
                  <input
                    type="text"
                    value={thresholdDraft.note}
                    onChange={(e) =>
                      setThresholdDraft((d) => ({ ...d, note: e.target.value }))
                    }
                    disabled={thresholdSaving}
                    data-testid="threshold-note"
                    placeholder={t("systemErrors.thresholdNotePlaceholder")}
                    className="w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={saveThreshold}
                  disabled={
                    thresholdSaving ||
                    (thresholdDraft.count === String(threshold.rateThresholdCount) &&
                      thresholdDraft.window ===
                        String(threshold.rateThresholdWindowMinutes) &&
                      thresholdDraft.note === (threshold.note ?? ""))
                  }
                  data-testid="threshold-save"
                >
                  {thresholdSaving
                    ? t("systemErrors.thresholdSaving")
                    : t("systemErrors.thresholdSave")}
                </Button>
              </div>
              {threshold.note && (
                <p
                  className="mt-2 text-xs text-gray-500 dark:text-gray-400 italic"
                  data-testid="threshold-current-note"
                >
                  {t("systemErrors.thresholdLastNote", { note: threshold.note })}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Tier 206 — top-N fingerprints by
            rate over the configured window.
            The Tier 205 threshold is the
            "noisy enough to push" line;
            this card shows which fingerprints
            are approaching or crossing it.
            Operator can decide to (a) raise
            the threshold, (b) mute the
            fingerprint, or (c) fix the root
            cause. We refresh on the same
            cadence as the timeline. */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <div className="text-sm">
                <span className="font-semibold text-gray-700 dark:text-gray-300">
                  {t("systemErrors.topRateTitle")}
                </span>
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                  {topRate ? t("systemErrors.topRateSubtitle", {
                    n: String(topRate.rows.length),
                    m: String(topRate.windowMinutes),
                  }) : ""}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={fetchTopRate}
                disabled={topRateLoading}
                data-testid="top-rate-refresh"
              >
                {t("common.refresh")}
              </Button>
            </div>
            {topRateLoading && !topRate ? (
              <SkeletonTable rows={3} cols={4} />
            ) : topRate && topRate.rows.length === 0 ? (
              <p
                className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center"
                data-testid="top-rate-empty"
              >
                {t("systemErrors.topRateEmpty")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 px-2 font-medium">
                        {t("systemErrors.topRateColFingerprint")}
                      </th>
                      <th className="py-2 px-2 font-medium text-right">
                        {t("systemErrors.topRateColCount")}
                      </th>
                      <th className="py-2 px-2 font-medium text-center">
                        {t("systemErrors.topRateColStatus")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("systemErrors.topRateColMessage")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {topRate?.rows.map((r) => (
                      <tr
                        key={r.fingerprint}
                        className="border-b border-gray-100 dark:border-gray-800"
                        data-testid="top-rate-row"
                      >
                        <td className="py-2 px-2 font-mono text-xs">
                          {r.fingerprintShort}
                        </td>
                        <td
                          className="py-2 px-2 text-right font-mono"
                          data-testid="top-rate-count"
                        >
                          {r.count}
                        </td>
                        <td className="py-2 px-2 text-center">
                          {r.exceeded ? (
                            <span
                              className="inline-block text-xs px-2 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                              data-testid="top-rate-exceeded"
                            >
                              {t("systemErrors.topRateExceeded")}
                            </span>
                          ) : (
                            <span
                              className="inline-block text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                              data-testid="top-rate-ok"
                            >
                              {t("systemErrors.topRateOk")}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400 truncate max-w-md">
                          {r.message ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tier 200 — 30-day error
            timeline. Stacked bar chart
            (open / resolved / muted) per
            day, with a per-source filter
            (All / Backend / Frontend) so
            the operator can see "is
            backend health degrading this
            week" at a glance. The chart
            is a tiny inline SVG (no
            chart library) — we have 30
            days × 3 series, 30 + 90
            = 120 segments which is well
            under SVG limits. */}
        {timeline && (
          <Card data-testid="timeline-card">
            <CardHeader>
              <CardTitle className="flex items-center justify-between flex-wrap gap-2">
                <span>
                  {t("systemErrors.timeline.title")} (
                  {t("systemErrors.timeline.lastDays", {
                    n: String(timeline.days),
                  })}
                  )
                </span>
                <div className="flex items-center gap-2 text-sm">
                  {(["all", "backend", "frontend"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setTimelineSource(s)}
                      className={`px-3 py-1 rounded ${
                        timelineSource === s
                          ? "bg-emerald-600 text-white"
                          : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                      }`}
                      data-testid={`timeline-source-${s}`}
                    >
                      {t(
                        `systemErrors.timeline.source${s[0].toUpperCase()}${s.slice(1)}`,
                      )}
                    </button>
                  ))}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {timelineLoading && !timeline ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("common.loading")}
                </p>
              ) : (
                <>
                  <div className="flex items-center gap-3 text-xs mb-2 flex-wrap">
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-block w-3 h-3 rounded-sm bg-red-500" />
                      {t("systemErrors.timeline.legendOpen")}:{" "}
                      {timeline.totals.open}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500" />
                      {t("systemErrors.timeline.legendResolved")}:{" "}
                      {timeline.totals.resolved}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-block w-3 h-3 rounded-sm bg-gray-400" />
                      {t("systemErrors.timeline.legendMuted")}:{" "}
                      {timeline.totals.muted}
                    </span>
                  </div>
                  <TimelineChart
                    buckets={timeline.buckets}
                    t={t}
                    locale={locale}
                  />
                </>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between flex-wrap gap-2">
              <span>
                {openCount} {t("systemErrors.openCount")} · {total}{" "}
                {t("systemErrors.totalCount")}
              </span>
              <div className="flex items-center gap-2 text-sm">
                {(["open", "resolved", "muted", "all"] as StatusFilter[]).map(
                  (s) => (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={`px-3 py-1 rounded ${
                        statusFilter === s
                          ? "bg-blue-600 text-white"
                          : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                      }`}
                    >
                      {t(`systemErrors.filter${s[0].toUpperCase()}${s.slice(1)}`)}
                    </button>
                  ),
                )}
                <span className="mx-1 text-gray-300">|</span>
                {(["all", "backend", "frontend"] as SourceFilter[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSourceFilter(s)}
                    className={`px-3 py-1 rounded ${
                      sourceFilter === s
                        ? "bg-emerald-600 text-white"
                        : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                    }`}
                  >
                    {t(`systemErrors.filter${s[0].toUpperCase()}${s.slice(1)}`)}
                  </button>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={prune}
                  disabled={total === 0}
                >
                  {t("systemErrors.prune")}
                </Button>
                {/* Tier 197 — bulk operations. Resolve-all
                    is destructive (closes the inbox), so we
                    use the default blue style. Mute-all is
                    reversible (an operator can re-open
                    one at a time), so we use the lighter
                    ghost variant. */}
                <Button
                  size="sm"
                  onClick={resolveAll}
                  disabled={busy || openCount === 0}
                  data-testid="resolve-all"
                >
                  {t("systemErrors.resolveAll")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={muteAll}
                  disabled={busy || openCount === 0}
                  data-testid="mute-all"
                >
                  {t("systemErrors.muteAll")}
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t("common.loading")}
              </p>
            ) : events.length === 0 ? (
              <p className="text-sm text-emerald-600 dark:text-emerald-400">
                {t("systemErrors.noErrors")}
              </p>
            ) : (
              <ul className="space-y-2">
                {events.map((ev) => (
                  <li
                    key={ev.id}
                    className={`border rounded-lg p-3 ${
                      ev.status === "open"
                        ? "border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10"
                        : ev.status === "muted"
                          ? "border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/40 opacity-70"
                          : "border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-900/10"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                              ev.source === "backend"
                                ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                                : "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
                            }`}
                          >
                            {ev.source}
                          </span>
                          {ev.statusCode && (
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-xs ${
                                ev.statusCode >= 500
                                  ? "bg-red-200 text-red-900 dark:bg-red-900 dark:text-red-200"
                                  : "bg-yellow-100 text-yellow-800"
                              }`}
                            >
                              {ev.statusCode}
                            </span>
                          )}
                          {ev.method && (
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {ev.method}
                            </span>
                          )}
                          {ev.occurrences > 1 && (
                            <span className="inline-block px-2 py-0.5 rounded text-xs bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
                              ×{ev.occurrences}
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-mono text-gray-900 dark:text-gray-100 mt-1 break-all">
                          {ev.message}
                        </p>
                        {ev.url && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                            {ev.url}
                          </p>
                        )}
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                          {t("systemErrors.lastSeen")}: {fmt(ev.lastSeenAt)}
                          {ev.firstSeenAt !== ev.lastSeenAt && (
                            <> · {t("systemErrors.firstSeen")}: {fmt(ev.firstSeenAt)}</>
                          )}
                        </p>
                      </div>
                      {ev.status === "open" && (
                        <div className="flex flex-col gap-1 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => resolve(ev.id)}
                          >
                            {t("systemErrors.resolve")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => mute(ev.id)}
                          >
                            {t("systemErrors.mute")}
                          </Button>
                        </div>
                      )}
                    </div>
                    {(ev.stack || ev.context) && (
                      <div className="mt-2">
                        <button
                          className="text-xs text-blue-600 hover:underline"
                          onClick={() =>
                            setExpandedId(expandedId === ev.id ? null : ev.id)
                          }
                        >
                          {expandedId === ev.id
                            ? t("systemErrors.hideStack")
                            : t("systemErrors.details")}
                        </button>
                        {expandedId === ev.id && (
                          <div className="mt-2 space-y-2">
                            {ev.stack && (
                              <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded overflow-auto max-h-64 text-gray-800 dark:text-gray-200">
                                {ev.stack}
                              </pre>
                            )}
                            {ev.context &&
                              Object.keys(ev.context).length > 0 && (
                                <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded overflow-auto max-h-32 text-gray-800 dark:text-gray-200">
                                  {JSON.stringify(ev.context, null, 2)}
                                </pre>
                              )}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}