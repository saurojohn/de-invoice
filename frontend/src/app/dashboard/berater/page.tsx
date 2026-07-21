"use client"

import { useEffect, useRef, useState, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, ApiError } from "@/lib/api"

interface BeraterAttachment {
  id: string
  originalName: string
  mimeType: string
  size: number
}

interface BeraterUser {
  id: string
  email: string
  profile: { name?: string } | null
}

interface BeraterNote {
  id: string
  companyId: string
  entityType: string
  entityId: string
  message: string
  status: "open" | "acknowledged" | "dismissed"
  createdById: string
  createdBy: BeraterUser
  createdAt: string
  acknowledgedBy: BeraterUser | null
  acknowledgedAt: string | null
  dismissedBy: BeraterUser | null
  dismissedAt: string | null
  attachment: BeraterAttachment | null
}

interface BeraterListResponse {
  items: BeraterNote[]
  total: number
}

type StatusFilter = "open" | "acknowledged" | "dismissed" | "all"

const ENTITY_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "invoice", label: "Rechnung" },
  { value: "expense", label: "Eingangsrechnung" },
  { value: "voucher", label: "Beleg" },
  { value: "customer", label: "Kunde" },
]

function formatDateDE(iso: string): string {
  try {
    return new Date(iso).toLocaleString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

function statusLabel(t: (k: string) => string, s: BeraterNote["status"]): string {
  if (s === "open") return t("berater.open")
  if (s === "acknowledged") return t("berater.acknowledged")
  return t("berater.dismissed")
}

function statusBadgeClass(s: BeraterNote["status"]): string {
  if (s === "open")
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
  if (s === "acknowledged")
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
  return "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
}

function entityLinkFor(entityType: string, entityId: string): string {
  if (entityType === "invoice") return `/dashboard/invoices/${entityId}`
  if (entityType === "expense") return `/dashboard/expenses/${entityId}`
  if (entityType === "voucher") return `/dashboard/accounting/vouchers`
  if (entityType === "customer") return `/dashboard/customers/${entityId}`
  return "#"
}

/**
 * Tier 79: Berater Document Exchange page.
 *
 * The single screen for both the Berater
 * (role='berater' on UserCompany) and the
 * Mandant. The two roles see the same queue,
 * but the action buttons differ:
 *
 *   - Berater: a "Neue Notiz" form at the
 *     top + a list of their own notes +
 *     a list of all notes on the same
 *     Mandant.
 *   - Mandant: the same list, with
 *     "Bestätigen" + "Schließen" buttons
 *     on every OPEN note.
 *
 * The role-aware rendering is a UI concern
 * (the server-side role check is the
 * authoritative guard — a Berater hitting
 * /acknowledge via curl still gets 403).
 */
export default function BeraterPage() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  // Tier 73 pattern: useToast/useI18n return fresh
  // objects every render — capture in refs so
  // useCallback deps stay stable.
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t

  const [companyId, setCompanyId] = useState<string | null>(null)
  const [callerRole, setCallerRole] = useState<string | null>(null)
  const [callerUserId, setCallerUserId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open")
  const [notes, setNotes] = useState<BeraterNote[]>([])
  const [loading, setLoading] = useState(false)
  // New note form state
  const [showForm, setShowForm] = useState(false)
  const [formMessage, setFormMessage] = useState("")
  const [formEntityType, setFormEntityType] = useState("invoice")
  const [formEntityId, setFormEntityId] = useState("")
  const [formFile, setFormFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Initial load: read companyId + callerRole from
  // localStorage. The /api/v1/users/me endpoint
  // could give us the per-company role, but we
  // have it on the login response too — the
  // existing login flow stores it as 'role' on
  // localStorage. If the user switches Mandant
  // (tier 66), the role for the active Mandant
  // is what matters; the simplest approach is to
  // call /users/me/companies to get the per-
  // company role. v1 uses a best-effort local
  // storage read; the server-side guard is
  // authoritative either way.
  useEffect(() => {
    if (typeof window === "undefined") return
    const id = localStorage.getItem("companyId")
    setCompanyId(id)
    const role = localStorage.getItem("role")
    setCallerRole(role)
    const uid = localStorage.getItem("userId")
    setCallerUserId(uid)
  }, [])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set("companyId", companyId)
      if (statusFilter !== "all") params.set("status", statusFilter)
      const data = await apiGet<BeraterListResponse>(
        `/api/v1/berater/notes?${params}`,
      )
      setNotes(data.items || [])
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("berater.loadError")
      toastRef.current.error(msg)
    } finally {
      setLoading(false)
    }
  }, [companyId, statusFilter])

  useEffect(() => {
    load()
  }, [load])

  const submitNewNote = useCallback(async () => {
    if (!companyId || !callerUserId) return
    if (!formMessage.trim() || !formEntityId.trim()) {
      toastRef.current.error(tRef.current("berater.createFailed"))
      return
    }
    setSubmitting(true)
    try {
      // multipart/form-data because we may
      // attach a file. The apiPost helper
      // handles auth headers; we build the
      // body manually because FormData needs
      // a multipart request.
      const fd = new FormData()
      fd.append("companyId", companyId)
      fd.append("entityType", formEntityType)
      fd.append("entityId", formEntityId.trim())
      fd.append("message", formMessage.trim())
      if (formFile) fd.append("file", formFile)
      const res = await fetch("/api/v1/berater/notes", {
        method: "POST",
        headers: {
          "x-user-id": callerUserId,
          "x-company-id": companyId,
        },
        body: fd,
      })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || `HTTP ${res.status}`)
      }
      toastRef.current.success(tRef.current("berater.success"))
      setShowForm(false)
      setFormMessage("")
      setFormEntityId("")
      setFormFile(null)
      load()
    } catch (e: any) {
      toastRef.current.error(
        e instanceof ApiError ? e.message : tRef.current("berater.createFailed"),
      )
    } finally {
      setSubmitting(false)
    }
  }, [companyId, callerUserId, formMessage, formEntityType, formEntityId, formFile, load])

  const actOnNote = useCallback(
    async (id: string, action: "acknowledge" | "dismiss") => {
      if (!companyId || !callerUserId) return
      try {
        // Use raw fetch here because the
        // apiPost helper doesn't expose the
        // auth headers (they're set on every
        // request by apiFetch internally).
        // We need x-user-id in the headers
        // because the controller reads it via
        // @CurrentUser to know which Mandant
        // is calling. apiPost would set it
        // automatically via apiFetch; the
        // 3-arg form of apiPost doesn't
        // exist.
        const res = await fetch(
          `/api/v1/berater/notes/${id}/${action}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-user-id": callerUserId,
              "x-company-id": companyId,
            },
            body: JSON.stringify({ companyId }),
          },
        )
        if (!res.ok) {
          const txt = await res.text()
          throw new Error(txt || `HTTP ${res.status}`)
        }
        toastRef.current.success(
          action === "acknowledge"
            ? tRef.current("berater.noteAcknowledged")
            : tRef.current("berater.noteDismissed"),
        )
        load()
      } catch (e: any) {
        const msg = e instanceof ApiError ? e.message : tRef.current("common.error")
        toastRef.current.error(msg)
      }
    },
    [companyId, callerUserId, load],
  )

  const isBerater = callerRole === "berater"
  // Mandant can act; Berater can NOT (the
  // server enforces this too, but the UI
  // matches the role boundary).
  const canCreate = isBerater
  const canAct = !isBerater

  const apiBase = useMemo(
    () =>
      typeof process !== "undefined"
        ? process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
        : "http://localhost:3001",
    [],
  )

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            📬 {tRef.current("berater.title")}
          </h1>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              Zurück
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 space-y-6" data-testid="berater-page">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {tRef.current("berater.subtitle")}
        </p>

        {/* Status filter pills */}
        <div className="flex flex-wrap gap-2" data-testid="berater-filter">
          {(
            [
              { value: "open", key: "berater.open" },
              { value: "acknowledged", key: "berater.acknowledged" },
              { value: "dismissed", key: "berater.dismissed" },
              { value: "all", key: "berater.all" },
            ] as { value: StatusFilter; key: string }[]
          ).map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              data-testid={`berater-filter-${f.value}`}
              className={`px-4 py-2 text-sm rounded-full border transition-colors ${
                statusFilter === f.value
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-700"
              }`}
            >
              {tRef.current(f.key)}
            </button>
          ))}
        </div>

        {/* Berater: new-note form */}
        {canCreate && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center justify-between">
                <span>✍️ {tRef.current("berater.newNote")}</span>
                {!showForm && (
                  <Button
                    size="sm"
                    onClick={() => setShowForm(true)}
                    data-testid="berater-new-btn"
                  >
                    +
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            {showForm && (
              <CardContent>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  {tRef.current("berater.newNoteHint")}
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {tRef.current("berater.entityType")}
                    </label>
                    <select
                      value={formEntityType}
                      onChange={(e) => setFormEntityType(e.target.value)}
                      className="border rounded px-3 py-2 w-full dark:bg-gray-800 dark:border-gray-700"
                      data-testid="berater-entityType"
                    >
                      {ENTITY_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {tRef.current("berater.entityId")}
                    </label>
                    <input
                      type="text"
                      value={formEntityId}
                      onChange={(e) => setFormEntityId(e.target.value)}
                      placeholder="z. B. UUID der Rechnung"
                      className="border rounded px-3 py-2 w-full dark:bg-gray-800 dark:border-gray-700 font-mono text-sm"
                      data-testid="berater-entityId"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {tRef.current("berater.message")}
                    </label>
                    <textarea
                      value={formMessage}
                      onChange={(e) => setFormMessage(e.target.value)}
                      placeholder={tRef.current("berater.messagePlaceholder")}
                      className="border rounded px-3 py-2 w-full dark:bg-gray-800 dark:border-gray-700"
                      rows={4}
                      data-testid="berater-message"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      {tRef.current("berater.attachmentOptional")}
                    </label>
                    <input
                      type="file"
                      onChange={(e) => setFormFile(e.target.files?.[0] || null)}
                      className="text-sm"
                      data-testid="berater-file"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={submitNewNote}
                      disabled={submitting}
                      data-testid="berater-submit"
                    >
                      {submitting
                        ? tRef.current("berater.submitting")
                        : tRef.current("berater.submit")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowForm(false)
                        setFormMessage("")
                        setFormEntityId("")
                        setFormFile(null)
                      }}
                    >
                      Abbrechen
                    </Button>
                  </div>
                </div>
              </CardContent>
            )}
          </Card>
        )}

        {/* Queue */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center justify-between">
              <span>
                {tRef.current("berater.title")} ({notes.length})
              </span>
              {loading && (
                <span className="text-sm text-gray-500">…</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {notes.length === 0 ? (
              <p
                className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center"
                data-testid="berater-empty"
              >
                {tRef.current("berater.noNotes")}
              </p>
            ) : (
              <div className="space-y-4" data-testid="berater-list">
                {notes.map((n) => (
                  <div
                    key={n.id}
                    className="border border-gray-200 dark:border-gray-700 rounded p-4 bg-white dark:bg-gray-900"
                    data-testid={`berater-note-${n.id}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${statusBadgeClass(n.status)}`}
                            data-testid={`berater-status-${n.id}`}
                          >
                            {statusLabel(tRef.current, n.status)}
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {n.entityType} ·{" "}
                            <a
                              href={entityLinkFor(n.entityType, n.entityId)}
                              className="font-mono hover:underline"
                            >
                              {n.entityId.slice(0, 8)}…
                            </a>
                          </span>
                        </div>
                        <p className="text-sm whitespace-pre-wrap mb-2">
                          {n.message}
                        </p>
                        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                          <div>
                            {tRef.current("berater.createdBy")}:{" "}
                            {n.createdBy?.profile?.name || n.createdBy?.email} ·{" "}
                            {formatDateDE(n.createdAt)}
                          </div>
                          {n.acknowledgedBy && n.acknowledgedAt && (
                            <div>
                              ✓ {tRef.current("berater.acknowledged")} von{" "}
                              {n.acknowledgedBy.profile?.name ||
                                n.acknowledgedBy.email}{" "}
                              am {formatDateDE(n.acknowledgedAt)}
                            </div>
                          )}
                          {n.dismissedBy && n.dismissedAt && (
                            <div>
                              ✗ {tRef.current("berater.dismissed")} von{" "}
                              {n.dismissedBy.profile?.name ||
                                n.dismissedBy.email}{" "}
                              am {formatDateDE(n.dismissedAt)}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-3">
                      {n.attachment && (
                        <a
                          href={`${apiBase}/api/v1/berater/notes/${n.id}/attachment?companyId=${companyId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                          data-testid={`berater-attachment-${n.id}`}
                        >
                          📎 {n.attachment.originalName} (
                          {Math.round(n.attachment.size / 1024)} KB)
                        </a>
                      )}
                      {canAct && n.status === "open" && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => actOnNote(n.id, "acknowledge")}
                            data-testid={`berater-ack-${n.id}`}
                          >
                            ✓ {tRef.current("berater.acknowledge")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => actOnNote(n.id, "dismiss")}
                            data-testid={`berater-dismiss-${n.id}`}
                          >
                            ✗ {tRef.current("berater.dismiss")}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
