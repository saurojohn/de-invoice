"use client"

/**
 * Tier 202 — Admin activity log (Berater read).
 *
 * Lists every operator action recorded
 * by `AuditService.writeActivity`:
 *   - error.resolve_all
 *   - error.mute_all
 *   - notification.test
 *   - cron.run_manually
 *   - webhook.requeue
 *
 * The list comes from
 * `GET /api/v1/audit-logs/activity`
 * which filters on the action
 * prefixes `error.`, `webhook.`,
 * `cron.`, `notification.` and
 * includes both the company's rows
 * AND cross-company admin rows
 * (companyId=null, e.g. cron
 * manual-run).
 *
 * Why a separate page (not a tab
 * inside `/dashboard/audit`):
 *   - Different audience. The full
 *     audit page is for "who
 *     changed what on the invoices
 *     / customers / etc". The
 *     activity page is for "what
 *     did the operator do" — a
 *     different question, with a
 *     different (Berater) consumer.
 *   - Different shape. Activity
 *     events have no `oldData` /
 *     `newData` diff to render —
 *     just a `metadata` blob with
 *     the per-action context.
 *
 * Each row has a "verify" button
 * that calls the same
 * `/audit-logs/:id/verify` endpoint
 * the audit page uses, so the
 * tamper-evident chain is checked
 * per row. The header also has a
 * "Verify chain" button that walks
 * the whole chain.
 */

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorBanner } from "@/components/ui/error-banner"
import { SkeletonTable } from "@/components/ui/skeleton"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet } from "@/lib/api"

interface ActivityRow {
  id: string
  action: string
  entityType: string
  entityId: string | null
  userId: string | null
  userEmail: string | null
  ipAddress: string | null
  createdAt: string
  // newData is the `metadata` blob
  // from writeActivity (e.g. {count:
  // 5} for resolve_all).
  newData: Record<string, any> | null
}

type ActionFilter = "all" | "error." | "webhook." | "cron." | "notification."

const ACTION_LABELS: Record<string, string> = {
  "error.resolve_all": "Fehler: alle als behoben markieren",
  "error.mute_all": "Fehler: alle stummschalten",
  "notification.test": "Test-Benachrichtigung senden",
  "cron.run_manually": "Cron manuell ausführen",
  "webhook.requeue": "Webhook-Zustellung erneut versuchen",
}

function actionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action]
  // Fall back to a prettified version
  // of the raw action name.
  return action
}

function actionBadgeClass(action: string): string {
  if (action.startsWith("error.")) {
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
  }
  if (action.startsWith("webhook.")) {
    return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
  }
  if (action.startsWith("cron.")) {
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
  }
  if (action.startsWith("notification.")) {
    return "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200"
  }
  return "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
}

export default function ActivityPage() {
  const router = useRouter()
  const { t, getDateLocale } = useI18n()
  const toast = useToast()
  const [companyId, setCompanyId] = useState<string>("")
  const [rows, setRows] = useState<ActivityRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all")
  // Tier 196 — chain verify state
  // (mirrors the audit page so the
  // Berater can confirm no row was
  // tampered with).
  const [chainOk, setChainOk] = useState<boolean | null>(null)
  const [verifying, setVerifying] = useState(false)

  const load = useCallback(
    async (cid: string) => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          companyId: cid,
          take: "200",
        })
        if (actionFilter !== "all") params.set("actionPrefix", actionFilter)
        const data = await apiGet<{
          rows: ActivityRow[]
          total: number
        }>(`/api/v1/audit-logs/activity?${params.toString()}`)
        setRows(data.rows || [])
        setTotal(data.total || 0)
      } catch (err) {
        setError(t("common.loadError"))
        setRows([])
        setTotal(0)
      } finally {
        setLoading(false)
      }
    },
    [actionFilter, t],
  )

  useEffect(() => {
    const cid = localStorage.getItem("companyId")
    if (!cid) {
      router.push("/login")
      return
    }
    setCompanyId(cid)
    load(cid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  // Refetch when the action filter
  // changes (separate effect so we
  // don't trigger a refetch on every
  // render of the parent component).
  useEffect(() => {
    if (!companyId) return
    load(companyId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionFilter])

  // Tier 196 — chain verify mirrors
  // the audit page logic. We call
  // the existing
  // `GET /api/v1/audit-logs/verify`
  // endpoint (Tier 196) which walks
  // the whole chain in `seq` order
  // (Tier 367 — was createdAt, which
  // could not order same-second rows).
  // The activity-log rows are part
  // of that chain.
  const verifyChain = async () => {
    if (!companyId) return
    setVerifying(true)
    try {
      const data = await apiGet<{ ok: boolean }>(
        `/api/v1/audit-logs/verify?companyId=${companyId}`,
      )
      setChainOk(data.ok)
      if (data.ok) {
        toast.success(t("activity.chainOk"))
      } else {
        toast.error(t("activity.chainBroken"))
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("common.loadError"),
      )
    } finally {
      setVerifying(false)
    }
  }

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
              {t("activity.title")}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t("activity.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/audit"
              className="text-sm text-blue-600 hover:underline"
            >
              {t("activity.auditLink")}
            </Link>
            <Link
              href="/dashboard"
              className="text-sm text-blue-600 hover:underline"
            >
              ← {t("nav.dashboard")}
            </Link>
            <LanguageSwitcher />
          </div>
        </div>

        {error && <ErrorBanner title={t("common.error")} message={error} />}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <span>
                {total} {t("activity.entries")}
              </span>
              {chainOk === true && (
                <span
                  className="text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
                  data-testid="chain-ok"
                >
                  {t("activity.chainOk")}
                </span>
              )}
              {chainOk === false && (
                <span
                  className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
                  data-testid="chain-broken"
                >
                  {t("activity.chainBroken")}
                </span>
              )}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={verifyChain}
                disabled={verifying}
                data-testid="activity-verify-chain"
              >
                {verifying
                  ? t("activity.verifying")
                  : t("activity.verifyChain")}
              </Button>
              {/* Tier 204 — CSV export for the
                  Berater's monthly compliance
                  review. The href preserves the
                  current `actionFilter` so the
                  downloaded file matches what the
                  operator was looking at on screen.
                  `target="_blank"` + the server's
                  `Content-Disposition: attachment`
                  header means the browser saves the
                  file directly without leaving the
                  page. We don't hold a long-lived
                  blob URL — the file is streamed
                  live from the backend. */}
              {companyId && (
                <a
                  href={`/api/v1/audit-logs/activity.csv?companyId=${companyId}&days=90${
                    actionFilter !== "all"
                      ? `&actionPrefix=${encodeURIComponent(actionFilter)}`
                      : ""
                  }`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="activity-export-csv"
                  className="text-xs px-3 py-1 border border-emerald-600 text-emerald-700 dark:text-emerald-300 rounded hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                >
                  {t("activity.exportCsv")}
                </a>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm mb-3 flex-wrap">
              <span className="text-gray-600 dark:text-gray-400">
                {t("activity.filterLabel")}:
              </span>
              {(
                ["all", "error.", "webhook.", "cron.", "notification."] as ActionFilter[]
              ).map((s) => (
                <button
                  key={s}
                  onClick={() => setActionFilter(s)}
                  className={`px-3 py-1 rounded ${
                    actionFilter === s
                      ? "bg-blue-600 text-white"
                      : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                  }`}
                  data-testid={`activity-filter-${s === "all" ? "all" : s.replace(".", "")}`}
                >
                  {s === "all"
                    ? t("activity.filterAll")
                    : s.replace(".", "")}
                </button>
              ))}
            </div>

            {loading ? (
              <SkeletonTable rows={5} cols={4} />
            ) : rows.length === 0 ? (
              <EmptyState
                title={t("activity.empty")}
                variant="inbox"
                fullWidth
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 px-2 font-medium">
                        {t("activity.colAction")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("activity.colActor")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("activity.colTarget")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("activity.colWhen")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("activity.colMeta")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-gray-100 dark:border-gray-800"
                        data-testid="activity-row"
                      >
                        <td className="py-2 px-2">
                          <span
                            className={`inline-block text-xs px-2 py-0.5 rounded ${actionBadgeClass(r.action)}`}
                          >
                            {actionLabel(r.action)}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-xs">
                          {r.userEmail || r.userId || "—"}
                        </td>
                        <td className="py-2 px-2 text-xs font-mono">
                          {r.entityType}
                          {r.entityId ? `/${r.entityId.slice(0, 8)}…` : ""}
                        </td>
                        <td className="py-2 px-2 text-xs">
                          {fmt(r.createdAt)}
                        </td>
                        <td className="py-2 px-2 text-xs text-gray-600 dark:text-gray-400">
                          {r.newData ? JSON.stringify(r.newData) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
