"use client"

/**
 * ReceiptsPanel — attachments UI for an Expense or Voucher.
 *
 * Shows the existing attachments (filename, size, MIME
 * type, uploaded-by, SHA-256 prefix for audit reference)
 * with actions: preview, download, delete. Also has a
 * file picker that uploads via /api/v1/attachments
 * (multipart/form-data with the magic FileInterceptor
 * on the server).
 *
 * Drag-and-drop is implemented via the native
 * DataTransfer API (no external dep) — the input
 * becomes a drop target with a visual "drop here"
 * overlay when a file is dragged over it.
 *
 * The preview button opens the file in a new tab via
 * the ?inline=1 default (server sends
 * Content-Disposition: inline). The download button
 * forces ?download=1 for Content-Disposition:
 * attachment with the original filename.
 *
 * The full OCR text (when present) is shown in a
 * collapsible panel — useful for the user to copy /
 * search without re-opening the original PDF.
 */

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { apiDelete, apiGet } from "@/lib/api"

export interface Attachment {
  id: string
  originalName: string
  mimeType: string
  size: number
  ocrText: string | null
  contentHash: string
  createdAt: string
  uploadedBy: { id: string; email: string } | null
}

interface Props {
  companyId: string
  entityType: "expense" | "voucher"
  entityId: string
  // Optional reload callback — fired after a successful
  // upload / delete so the parent can refresh derived
  // data (e.g. the attachment count badge in the row).
  onChange?: () => void
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

// Map a MIME type to a small inline icon (we keep
// these inline instead of pulling in an icon library
// — three glyphs aren't worth the dep).
function mimeIcon(mime: string): string {
  if (mime === "application/pdf") return "📄"
  if (mime.startsWith("image/")) return "🖼"
  if (mime.startsWith("text/")) return "📝"
  return "📎"
}

export function ReceiptsPanel({ companyId, entityType, entityId, onChange }: Props) {
  const { t } = useI18n()
  const [items, setItems] = useState<Attachment[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [expandedOcrId, setExpandedOcrId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Fetch the attachment list. We re-fetch on every
  // entityId change so the panel shows the right
  // attachments for the currently-selected expense /
  // voucher. We also re-fetch after a successful
  // upload / delete (via onChange callback).
  const load = async () => {
    setLoading(true)
    try {
      const data = await apiGet<Attachment[]>(
        `/api/v1/attachments?companyId=${companyId}&entityType=${entityType}&entityId=${entityId}`,
      )
      setItems(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error("attachment list failed", e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (entityId) load()
  }, [companyId, entityId]) // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const userId = localStorage.getItem("userId") || ""
    for (const file of Array.from(files)) {
      setUploading(true)
      try {
        const fd = new FormData()
        fd.append("file", file)
        fd.append("companyId", companyId)
        fd.append("entityType", entityType)
        fd.append("entityId", entityId)
        if (userId) fd.append("uploadedById", userId)
        const res = await fetch("/api/v1/attachments", {
          method: "POST",
          // Note: don't set Content-Type — the browser
          // must add the multipart boundary itself.
          // Setting it manually breaks the request
          // (see NestJS / multer requirements).
          body: fd,
          credentials: "include",
          headers: {
            "x-user-id": localStorage.getItem("userId") || "",
            "x-company-id": companyId,
          },
        })
        if (!res.ok) {
          const errText = await res.text()
          console.error(`Upload failed for ${file.name}:`, errText)
        }
      } catch (e) {
        console.error(`Upload error for ${file.name}:`, e)
      }
    }
    setUploading(false)
    await load()
    onChange?.()
  }

  const remove = async (id: string) => {
    if (!confirm(t("expenses.deleteConfirm"))) return
    try {
      await apiDelete(`/api/v1/attachments/${id}?companyId=${companyId}`)
      await load()
      onChange?.()
    } catch (e) {
      console.error("delete failed", e)
    }
  }

  const downloadUrl = (id: string) =>
    `/api/v1/attachments/${id}/file?companyId=${companyId}&download=1`
  const previewUrl = (id: string) =>
    `/api/v1/attachments/${id}/file?companyId=${companyId}`

  return (
    <div className="space-y-4">
      {/* Drop zone — also acts as the file-picker
          trigger. The visual state changes when a
          file is dragged over (dragOver = true). */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          upload(e.dataTransfer.files)
        }}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition ${
          dragOver
            ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
            : "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/tiff,text/plain"
          multiple
          onChange={(e) => upload(e.target.files)}
          className="hidden"
        />
        <div className="text-2xl mb-1">📎</div>
        <div className="text-sm text-gray-600 dark:text-gray-300">
          {uploading
            ? t("expenses.uploading")
            : t("expenses.dragDrop")}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          PDF, JPEG, PNG, WebP, TIFF, TXT — max. 10 MB pro Datei
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">
          {t("common.loading")}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">
          {t("expenses.noReceipts")}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((a) => (
            <div
              key={a.id}
              className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-white dark:bg-gray-800"
            >
              <div className="flex items-start gap-3">
                <div className="text-2xl flex-shrink-0">{mimeIcon(a.mimeType)}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate">
                    {a.originalName}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {fmtBytes(a.size)} · {a.mimeType}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t("expenses.uploadedAt")}: {fmtDate(a.createdAt)}
                    {a.uploadedBy && (
                      <> · {t("expenses.uploadedBy")}: {a.uploadedBy.email}</>
                    )}
                  </div>
                  <details className="mt-1">
                    <summary className="text-xs text-gray-400 dark:text-gray-500 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300">
                      {t("expenses.hash")}: {a.contentHash.slice(0, 16)}…
                    </summary>
                    <div className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400 break-all pl-2">
                      {a.contentHash}
                    </div>
                  </details>
                </div>
                <div className="flex flex-col gap-1 flex-shrink-0">
                  {a.mimeType.startsWith("image/") || a.mimeType === "application/pdf" ? (
                    <a
                      href={previewUrl(a.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 text-center"
                    >
                      {t("expenses.preview")}
                    </a>
                  ) : null}
                  <a
                    href={downloadUrl(a.id)}
                    className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 text-center"
                  >
                    {t("expenses.download")}
                  </a>
                  <button
                    onClick={() => remove(a.id)}
                    className="text-xs px-2 py-1 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    {t("expenses.delete")}
                  </button>
                </div>
              </div>
              {/* OCR text panel — shown on demand so
                  the row doesn't bloat when there are
                  20 attachments. The text is fetched
                  lazily (the list endpoint doesn't
                  return ocrText to keep payloads small
                  — actually we do return it, so we
                  just toggle visibility). */}
              {a.ocrText && a.ocrText.length > 0 && (
                <div className="mt-2">
                  <button
                    onClick={() =>
                      setExpandedOcrId(expandedOcrId === a.id ? null : a.id)
                    }
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {expandedOcrId === a.id
                      ? t("expenses.hideOcr")
                      : `${t("expenses.showOcr")} (${a.ocrText.length.toLocaleString("de-DE")} ${t("expenses.ocrText").toLowerCase()})`}
                  </button>
                  {expandedOcrId === a.id && (
                    <pre className="mt-2 text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono">
                      {a.ocrText}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
