"use client"

/**
 * Tier 745 — the Belege taken off a record: who took them off and when, to
 * look at and to put back. A Beleg is not deleted (Tier 740), so this is the
 * way back; it was a statement in the database. Nothing is shown while there
 * are none, or to a role that may not change the record (the server decides:
 * the refusal is shown).
 */
import { useCallback, useEffect, useState } from "react"

import { apiGet, apiPost } from "@/lib/api"
import { useI18n } from "@/components/useI18n"

interface RemovedAttachment {
  id: string
  originalName: string
  size: number
  deletedAt: string
  deletedBy: string | null
}

export function RemovedAttachments({ companyId, entityType, entityId, version, onRestored }: {
  companyId: string
  entityType: "expense" | "voucher" | "invoice"
  entityId: string
  /** changes when the list of Belege above changed */
  version?: unknown
  onRestored?: () => void
}) {
  const { t, getDateLocale } = useI18n()
  const [rows, setRows] = useState<RemovedAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await apiGet<RemovedAttachment[]>(
        `/api/v1/attachments/removed?companyId=${companyId}&entityType=${entityType}&entityId=${entityId}`,
      )
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setRows([])
    }
  }, [companyId, entityType, entityId])

  useEffect(() => {
    if (entityId) load()
  }, [entityId, version, load])

  if (rows.length === 0) return null

  const restore = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      await apiPost(`/api/v1/attachments/${id}/restore?companyId=${companyId}`)
      await load()
      onRestored?.()
    } catch (e) {
      setError((e as Error)?.message || t("expenses.attachmentRestoreFailed"))
    } finally {
      setBusy(null)
    }
  }

  return (
    <details className="rounded border border-gray-200 p-2 text-sm dark:border-gray-700" data-testid="attachments-removed">
      <summary className="cursor-pointer text-gray-600 dark:text-gray-300">
        {t("expenses.attachmentsRemoved", { count: rows.length })}
      </summary>
      {error && (
        <div role="alert" data-testid="attachment-restore-error" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}
      <ul className="mt-2 space-y-2">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="attachment-removed-row">
            <span className="min-w-0 break-all">
              <span className="text-gray-900 dark:text-gray-100">{a.originalName}</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                {t("expenses.attachmentRemovedOn", {
                  date: new Date(a.deletedAt).toLocaleDateString(getDateLocale()),
                  by: a.deletedBy ?? "—",
                })}
              </span>
            </span>
            <span className="flex gap-1">
              <a
                href={`/api/v1/attachments/${a.id}/file?companyId=${companyId}&removed=1`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {t("expenses.preview")}
              </a>
              <button
                type="button"
                onClick={() => restore(a.id)}
                disabled={busy === a.id}
                data-testid="attachment-restore"
                className="text-xs px-2 py-1 border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50"
              >
                {t("expenses.attachmentRestore")}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}
