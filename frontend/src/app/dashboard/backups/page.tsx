"use client"

/**
 * Backup-Management — Tier 120 admin page.
 *
 * Renders GET /api/v1/admin/backups as a table. The
 * Berater (Steuerberater) + Mandant (business owner)
 * land here when "is the backup actually working?"
 * is the question. The page mirrors the cron-health
 * pattern: header with the health colour + a
 * "trigger backup now" button + per-row verify/delete
 * actions.
 *
 * Why a dedicated admin page (not part of system-health)?
 *   - The "trigger backup" + "verify backup" actions
 *     are unique to this domain. Folding them into the
 *     cron-health table would conflate "cron metadata"
 *     with "backup file management".
 *   - The per-row table is dense (size / age / has-db /
 *     has-attachments / verification status) and would
 *     bloat the cron-health row layout.
 *
 * Auto-refresh matches the cron-health 30s tick.
 * Verifying a backup is slow (docker cp + pg_restore
 * --list) so we disable the per-row verify button
 * while in flight and show a spinner.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiDelete } from "@/lib/api"

interface BackupInfo {
  id: string
  dir: string
  createdAt: string
  sizeBytes: number
  dbFile: string | null
  dbSizeBytes: number
  attachmentsFile: string | null
  attachmentsSizeBytes: number
  isComplete: boolean
  ageHours: number
}

interface BackupListResponse {
  items: BackupInfo[]
  newest: BackupInfo | null
  health: "green" | "amber" | "red" | "grey"
  backupRoot: string
}

interface VerifyResult {
  valid: boolean
  tableCount: number
  error?: string
}

interface RunResult {
  success: boolean
  id: string
  sizeBytes: number
  durationMs: number
  log: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} d`
}

function healthBg(health: "green" | "amber" | "red" | "grey"): string {
  switch (health) {
    case "green":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
    case "amber":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
    case "red":
      return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
    case "grey":
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
  }
}

export default function BackupsPage() {
  const { t, getDateLocale } = useI18n()
  const toast = useToast()
  const [data, setData] = useState<BackupListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [verifying, setVerifying] = useState<string | null>(null)
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({})
  const [deleting, setDeleting] = useState<string | null>(null)
  const [lastRun, setLastRun] = useState<RunResult | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await apiGet<BackupListResponse>("/api/v1/admin/backups")
      setData(res)
    } catch (e: any) {
      toast.error(t("backup.loadingError") + ": " + (e?.message || e))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  // Initial load + auto-refresh every 30s. Matches the
  // cron-health cadence so the operator sees both
  // pages update at the same beat.
  useEffect(() => {
    load()
    const i = setInterval(load, 30_000)
    return () => clearInterval(i)
  }, [load])

  const trigger = useCallback(async () => {
    if (!window.confirm(t("backup.triggerConfirm"))) return
    setRunning(true)
    try {
      const res = await apiPost<RunResult>("/api/v1/admin/backups/run", {})
      setLastRun(res)
      if (res.success) {
        toast.success(
          t("backup.triggerSuccess").replace("{id}", res.id).replace("{size}", formatBytes(res.sizeBytes)),
        )
      } else {
        toast.error(t("backup.triggerFailed"))
      }
      load()
    } catch (e: any) {
      toast.error(t("backup.loadingError") + ": " + (e?.message || e))
    } finally {
      setRunning(false)
    }
  }, [t, toast, load])

  const verify = useCallback(
    async (id: string) => {
      setVerifying(id)
      try {
        const res = await apiPost<VerifyResult>(
          `/api/v1/admin/backups/${id}/verify`,
          {},
        )
        setVerifyResults((prev) => ({ ...prev, [id]: res }))
        if (res.valid) {
          toast.success(
            t("backup.verifyOk").replace("{n}", String(res.tableCount)),
          )
        } else {
          toast.error(
            t("backup.verifyFailed") + ": " + (res.error || "unknown"),
          )
        }
      } catch (e: any) {
        toast.error(t("backup.loadingError") + ": " + (e?.message || e))
      } finally {
        setVerifying(null)
      }
    },
    [t, toast],
  )

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm(t("backup.deleteConfirm").replace("{id}", id))) return
      setDeleting(id)
      try {
        await apiDelete(`/api/v1/admin/backups/${id}`)
        toast.success(t("backup.deleted").replace("{id}", id))
        // Clear verify result for this id too
        setVerifyResults((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        load()
      } catch (e: any) {
        toast.error(t("backup.loadingError") + ": " + (e?.message || e))
      } finally {
        setDeleting(null)
      }
    },
    [t, toast, load],
  )

  const items = data?.items ?? []
  const health = data?.health ?? "grey"

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("backup.title")}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t("backup.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={load}
            disabled={loading}
            data-testid="backup-refresh"
            variant="secondary"
          >
            {t("backup.refresh")}
          </Button>
          <Button
            onClick={trigger}
            disabled={running}
            data-testid="backup-trigger"
          >
            {running ? t("backup.triggerRunning") : t("backup.trigger")}
          </Button>
        </div>
      </div>

      {/* Health chip + newest summary */}
      <div className="flex flex-wrap gap-3 text-sm">
        <div
          className={`px-3 py-1 rounded-full font-medium ${healthBg(health)}`}
          data-testid="backup-health"
        >
          {t("backup.lastBackup")}:{" "}
          {data?.newest
            ? t("backup.ageLabel").replace("{n}", formatAge(data.newest.ageHours))
            : t("backup.never")}
          {/* Tier 359: the backend now scores a newest backup without
              db.sql.gz red regardless of age; say why, or a red chip
              reading "3 h ago" looks like a bug. */}
          {data?.newest && !data.newest.isComplete && (
            <span data-testid="backup-health-no-db">
              {" · "}
              {t("backup.noDatabase")}
            </span>
          )}
        </div>
        {data?.newest && (
          <div className="px-3 py-1 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
            {formatBytes(data.newest.sizeBytes)} ·{" "}
            {new Date(data.newest.createdAt).toLocaleString(getDateLocale())}
          </div>
        )}
        {data?.backupRoot && (
          <div className="px-3 py-1 rounded-full bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 font-mono text-xs">
            {data.backupRoot}
          </div>
        )}
      </div>

      {/* Last run summary (after a manual trigger) */}
      {lastRun && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {lastRun.success ? t("backup.runOk") : t("backup.runFailed")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre
              className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded overflow-x-auto max-h-48"
              data-testid="backup-last-log"
            >
              {lastRun.log}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          {loading && items.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">{t("backup.loading")}</p>
          ) : items.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400">{t("backup.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="backup-table">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-3">{t("backup.colId")}</th>
                    <th className="text-left py-2 pr-3">{t("backup.colCreated")}</th>
                    <th className="text-right py-2 pr-3">{t("backup.colSize")}</th>
                    <th className="text-left py-2 pr-3">{t("backup.colDb")}</th>
                    <th className="text-left py-2 pr-3">{t("backup.colAtt")}</th>
                    <th className="text-left py-2 pr-3">{t("backup.colVerify")}</th>
                    <th className="text-right py-2">{t("backup.colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((b) => {
                    const verifyResult = verifyResults[b.id]
                    return (
                      <tr
                        key={b.id}
                        className="border-b hover:bg-gray-50 dark:hover:bg-gray-800"
                        data-testid={`backup-row-${b.id}`}
                      >
                        <td className="py-2 pr-3 font-mono text-xs">{b.id}</td>
                        <td className="py-2 pr-3 text-gray-600 dark:text-gray-300">
                          {new Date(b.createdAt).toLocaleString(getDateLocale())}
                          <span className="text-gray-400 ml-1">
                            ({formatAge(b.ageHours)})
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-mono">
                          {formatBytes(b.sizeBytes)}
                        </td>
                        <td className="py-2 pr-3">
                          {b.dbFile ? (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              ✓ {formatBytes(b.dbSizeBytes)}
                            </span>
                          ) : (
                            <span className="text-red-600 dark:text-red-400">✗</span>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          {b.attachmentsFile ? (
                            <span className="text-emerald-600 dark:text-emerald-400">
                              ✓ {formatBytes(b.attachmentsSizeBytes)}
                            </span>
                          ) : (
                            <span className="text-gray-400">–</span>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          {verifyResult ? (
                            verifyResult.valid ? (
                              <span className="text-emerald-600 dark:text-emerald-400">
                                ✓ {verifyResult.tableCount} {t("backup.tables")}
                              </span>
                            ) : (
                              <span className="text-red-600 dark:text-red-400">
                                ✗ {t("backup.invalid")}
                              </span>
                            )
                          ) : (
                            <span className="text-gray-400">–</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <div className="flex gap-2 justify-end">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => verify(b.id)}
                              disabled={verifying === b.id}
                              data-testid={`backup-verify-${b.id}`}
                            >
                              {verifying === b.id
                                ? t("backup.verifying")
                                : t("backup.verify")}
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => remove(b.id)}
                              disabled={deleting === b.id}
                              data-testid={`backup-delete-${b.id}`}
                            >
                              {deleting === b.id
                                ? t("backup.deleting")
                                : t("backup.delete")}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}