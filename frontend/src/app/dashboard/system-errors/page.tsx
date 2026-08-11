"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost } from "@/lib/api"

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

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    const userId = localStorage.getItem("userId") || ""
    if (!companyId) {
      router.push("/login")
      return
    }
    load()
  }, [load, router])

  const resolve = async (id: string) => {
    try {
      await apiPost(`/api/v1/system/errors/${id}/resolve`)
      toast.success(t("systemErrors.resolved"))
      load()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const mute = async (id: string) => {
    try {
      await apiPost(`/api/v1/system/errors/${id}/mute`)
      toast.success(t("systemErrors.muted"))
      load()
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
    } catch (e: any) {
      toast.error(e.message)
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