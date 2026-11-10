"use client"

/**
 * Tier 805 — the deadlines as a calendar subscription (GET/POST/DELETE
 * /ustva/calendar). The link is shown once, right after it is made: the
 * company keeps only its hash. A new link replaces the old one. Admins only —
 * for anyone else GET answers 403 and the section is not shown.
 */
import { useEffect, useState } from "react"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiDelete, apiGet, apiPost } from "@/lib/api"
import { askConfirm } from "@/components/ConfirmDialog" // Tier 827

interface CalendarStatus { active: boolean; createdAt: string | null; createdBy: string | null }

export default function CalendarLinkSection() {
  const { t, getDateLocale } = useI18n()
  const toast = useToast()
  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const companyId = typeof window !== "undefined" ? localStorage.getItem("companyId") : null

  useEffect(() => {
    if (!companyId) return
    let alive = true
    apiGet<CalendarStatus>(`/api/v1/ustva/calendar?companyId=${companyId}`)
      .then((s) => { if (alive) setStatus(s) })
      .catch(() => { /* not an admin: nothing to show */ })
    return () => { alive = false }
  }, [companyId])

  if (!status || !companyId) return null

  const create = async () => {
    if (status.active && !await askConfirm(t("deadlines.calendarReplaceConfirm"))) return
    setBusy(true)
    try {
      const r = await apiPost<CalendarStatus & { url: string }>(`/api/v1/ustva/calendar?companyId=${companyId}`, {})
      setStatus(r)
      setUrl(r.url)
    } catch (e: any) {
      toast.error(e?.message || t("common.saveError"))
    } finally {
      setBusy(false)
    }
  }
  const revoke = async () => {
    if (!await askConfirm(t("deadlines.calendarRevokeConfirm"))) return
    setBusy(true)
    try {
      setStatus(await apiDelete<CalendarStatus>(`/api/v1/ustva/calendar?companyId=${companyId}`))
      setUrl(null)
      toast.success(t("deadlines.calendarRevoked"))
    } catch (e: any) {
      toast.error(e?.message || t("common.saveError"))
    } finally {
      setBusy(false)
    }
  }
  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t("deadlines.calendarCopied"))
    } catch {
      toast.error(t("deadlines.calendarCopyFailed"))
    }
  }
  const since = status.createdAt ? new Date(status.createdAt).toLocaleDateString(getDateLocale()) : ""

  return (
    <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4 text-sm" data-testid="calendar-link">
      <div className="font-medium text-gray-700 dark:text-gray-200">{t("deadlines.calendarTitle")}</div>
      <p className="mt-1 text-xs text-gray-500">{t("deadlines.calendarHint")}</p>
      {status.active && !url && (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-300" data-testid="calendar-link-active">
          {t("deadlines.calendarActive", { date: since, user: status.createdBy ?? "—" })}
        </p>
      )}
      {url && (
        <div className="mt-2 space-y-2" data-testid="calendar-link-new">
          <p className="text-xs text-amber-700 dark:text-amber-400">{t("deadlines.calendarShownOnce")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
              className="min-w-0 flex-1 basis-64 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded-md bg-gray-50 dark:bg-gray-800 font-mono text-xs"
              data-testid="calendar-link-url"
            />
            <button type="button" onClick={copy} className="px-3 py-1 border rounded-md" data-testid="calendar-link-copy">
              {t("deadlines.calendarCopy")}
            </button>
            <a href={url.replace(/^https?:/, "webcal:")} className="px-3 py-1 border rounded-md" data-testid="calendar-link-open">
              {t("deadlines.calendarOpen")}
            </a>
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={create} className="px-3 py-1 border rounded-md disabled:opacity-50" data-testid="calendar-link-create">
          {t(status.active ? "deadlines.calendarReplace" : "deadlines.calendarCreate")}
        </button>
        {status.active && (
          <button type="button" disabled={busy} onClick={revoke} className="px-3 py-1 border rounded-md text-red-700 dark:text-red-400 disabled:opacity-50" data-testid="calendar-link-revoke">
            {t("deadlines.calendarRevoke")}
          </button>
        )}
      </div>
    </div>
  )
}
