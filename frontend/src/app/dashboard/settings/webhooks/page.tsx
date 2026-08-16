"use client"

/**
 * Tier 14.4: Webhook administration UI.
 *
 * Three sections:
 *
 * 1. **List** — every webhook for the
 *    company, with the status badge,
 *    a per-row actions menu
 *    (Test / Pause-Resume / Deliveries
 *    history / Delete), and a "Webhook
 *    hinzufügen" CTA that opens the
 *    create modal.
 *
 * 2. **Create modal** — name + URL +
 *    multi-select event checkboxes +
 *    optional description. On submit,
 *    the API returns the secret ONCE;
 *    we display it in a confirmation
 *    dialog with a "Copy to clipboard"
 *    button. We never store the secret
 *    in component state past this dialog.
 *
 * 3. **Deliveries drawer** — when the
 *    user clicks "Zustellungen" on a
 *    webhook, we open a side panel that
 *    shows the last 50 delivery attempts
 *    with HTTP status, response body
 *    preview, retryCount, nextRetryAt.
 *    This is the operator's debug
 *    surface for "why didn't my
 *    integration receive the event?".
 *
 * Why a modal/dialog pattern (not a
 * separate page)?
 *   - The webhooks list IS small
 *     (typically <10 per company).
 *   - The create form is short
 *     (5 fields).
 *   - A separate /webhooks/new page
 *     would require navigation +
 *     back/forward state — overkill
 *     for a 30-second form.
 *
 * Why a side drawer for deliveries
 * (not a modal)?
 *   - Delivery history can be long
 *     (50 rows + statusCode + responseBody
 *     preview = needs vertical scroll).
 *   - A modal would feel cramped.
 *   - A drawer preserves context: the
 *     webhook list stays visible in the
 *     background.
 */

import { useEffect, useState, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorBanner } from "@/components/ui/error-banner"
import { SkeletonTable } from "@/components/ui/skeleton"
import LanguageSwitcher from "@/components/LanguageSwitcher"

interface Webhook {
  id: string
  companyId: string
  name: string
  url: string
  // Backend returns events as a JSON string (e.g. '["invoice.created"]')
  events: string | string[]
  status: "active" | "paused" | "disabled"
  description: string | null
  createdAt: string
  updatedAt: string
}

interface WebhookDelivery {
  id: string
  webhookId: string
  eventType: string
  eventId: string
  status: "pending" | "success" | "failed" | "exhausted"
  statusCode: number | null
  durationMs: number | null
  retryCount: number
  errorMessage: string | null
  attemptedAt: string
  nextRetryAt: string | null
}

// Tier 198 — dead-letter row includes the
// joined-in webhook name/url so the page
// can render "Acme CRM failed" without a
// second round-trip per row.
interface DeadLetterDelivery extends WebhookDelivery {
  webhook: { name: string; url: string }
}

// All event types the backend can emit.
// Keep this list in sync with
// WebhookEventType in
// backend/src/modules/webhook/webhook.service.ts.
const ALL_EVENT_TYPES: { type: string; key: string }[] = [
  { type: "invoice.created", key: "invoiceCreated" },
  { type: "invoice.updated", key: "invoiceUpdated" },
  { type: "invoice.paid", key: "invoicePaid" },
  { type: "invoice.sent", key: "invoiceSent" },
  { type: "invoice.deleted", key: "invoiceDeleted" },
  { type: "payment.received", key: "paymentReceived" },
  { type: "voucher.created", key: "voucherCreated" },
  { type: "voucher.posted", key: "voucherPosted" },
  { type: "voucher.reversed", key: "voucherReversed" },
  { type: "customer.created", key: "customerCreated" },
  { type: "customer.updated", key: "customerUpdated" },
  { type: "company.updated", key: "companyUpdated" },
]

function parseEvents(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—"
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

function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    case "paused":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
    case "disabled":
      return "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
    case "success":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    case "failed":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
    case "exhausted":
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
    case "pending":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
  }
}

export default function WebhooksPage() {
  const { t } = useI18n()
  const toast = useToast()
  const router = useRouter()

  const [companyId, setCompanyId] = useState<string>("")
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create modal
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState("")
  const [newUrl, setNewUrl] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [newEvents, setNewEvents] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Secret dialog (shown after successful create)
  const [secretDialog, setSecretDialog] = useState<{
    name: string
    secret: string
  } | null>(null)
  const [secretCopied, setSecretCopied] = useState(false)

  // Deliveries drawer
  const [drawerWebhook, setDrawerWebhook] = useState<Webhook | null>(null)
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [drawerLoading, setDrawerLoading] = useState(false)

  // Test result toast
  const [testingId, setTestingId] = useState<string | null>(null)

  // Replay in-flight state. Per-row
  // button shows "Wird gesendet…"
  // while the POST is in flight.
  const [replayingId, setReplayingId] = useState<string | null>(null)

  // Tier 198 — Dead-Letter Queue (cross-webhook
  // view of every exhausted delivery for the
  // company). Pulled alongside the main webhooks
  // list on mount and after any requeue action.
  const [deadLetter, setDeadLetter] = useState<DeadLetterDelivery[]>([])
  const [deadLetterLoading, setDeadLetterLoading] = useState(false)
  // Per-row in-flight state for the requeue
  // button on the dead-letter section AND
  // on the per-webhook drawer exhausted row.
  const [requeuingId, setRequeuingId] = useState<string | null>(null)

  // ---- Effects ----
  useEffect(() => {
    const cid = localStorage.getItem("companyId")
    if (cid) {
      setCompanyId(cid)
      fetchWebhooks(cid)
      fetchDeadLetter(cid)
    } else {
      setLoading(false)
    }
  }, [])

  const fetchWebhooks = useCallback(async (cid: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiGet<Webhook[]>(
        `/api/v1/webhooks?companyId=${cid}`,
      )
      setWebhooks(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(t("webhooks.errors.loadFailed"))
    } finally {
      setLoading(false)
    }
  }, [t])

  const fetchDeliveries = useCallback(
    async (cid: string, whId: string) => {
      setDrawerLoading(true)
      try {
        const data = await apiGet<WebhookDelivery[]>(
          `/api/v1/webhooks/${whId}/deliveries?companyId=${cid}&limit=50`,
        )
        setDeliveries(Array.isArray(data) ? data : [])
      } catch {
        setDeliveries([])
      } finally {
        setDrawerLoading(false)
      }
    },
    [],
  )

  // Tier 198 — fetch the cross-webhook
  // dead-letter list (status='exhausted'
  // rows). Reused after a requeue action
  // so the UI reflects the new state.
  const fetchDeadLetter = useCallback(async (cid: string) => {
    setDeadLetterLoading(true)
    try {
      const data = await apiGet<DeadLetterDelivery[]>(
        `/api/v1/webhooks/deliveries/dead-letter?companyId=${cid}&limit=100`,
      )
      setDeadLetter(Array.isArray(data) ? data : [])
    } catch {
      setDeadLetter([])
    } finally {
      setDeadLetterLoading(false)
    }
  }, [])

  // ---- Actions ----
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim() || !newUrl.trim() || newEvents.size === 0) {
      setCreateError(
        "Name, URL und mindestens ein Ereignis sind erforderlich.",
      )
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const created = await apiPost<Webhook & { secret: string }>(
        `/api/v1/webhooks?companyId=${companyId}`,
        {
          name: newName.trim(),
          url: newUrl.trim(),
          description: newDescription.trim() || undefined,
          events: Array.from(newEvents),
        },
      )
      // Close modal, show secret dialog
      setShowCreate(false)
      setSecretDialog({ name: created.name, secret: created.secret })
      setNewName("")
      setNewUrl("")
      setNewDescription("")
      setNewEvents(new Set())
      // Refresh list
      await fetchWebhooks(companyId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ""
      setCreateError(
        msg || t("webhooks.errors.createFailed"),
      )
    } finally {
      setCreating(false)
    }
  }

  const handleTogglePause = async (wh: Webhook) => {
    const newStatus = wh.status === "paused" ? "active" : "paused"
    try {
      await apiPatch(`/api/v1/webhooks/${wh.id}?companyId=${companyId}`, {
        status: newStatus,
      })
      await fetchWebhooks(companyId)
      toast.success(
        newStatus === "paused"
          ? `„${wh.name}" pausiert`
          : `„${wh.name}" wieder aktiv`,
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("webhooks.errors.updateFailed"),
      )
    }
  }

  const handleDelete = async (wh: Webhook) => {
    if (!confirm(t("webhooks.deleteConfirm"))) return
    try {
      await apiDelete(
        `/api/v1/webhooks/${wh.id}?companyId=${companyId}`,
      )
      await fetchWebhooks(companyId)
      toast.success(`„${wh.name}" gelöscht`)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("webhooks.errors.deleteFailed"),
      )
    }
  }

  const handleTest = async (wh: Webhook) => {
    setTestingId(wh.id)
    try {
      await apiPost(
        `/api/v1/webhooks/${wh.id}/test?companyId=${companyId}`,
      )
      toast.success(t("webhooks.testSent"))
      // Refresh the list so any successful
      // delivery shows up in the webhook's
      // delivery count.
      await fetchWebhooks(companyId)
      // If the drawer is open for this
      // webhook, refresh it too.
      if (drawerWebhook?.id === wh.id) {
        await fetchDeliveries(companyId, wh.id)
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("webhooks.errors.testFailed"),
      )
    } finally {
      setTestingId(null)
    }
  }

  /**
   * Manually replay a past delivery.
   *
   * The button is per-row in the
   * deliveries drawer. We POST to
   * /webhooks/deliveries/:id/replay,
   * which creates a new delivery
   * row with the same eventId (so
   * receivers can dedupe) and
   * re-POSTs the payload to the
   * webhook URL.
   *
   * The original delivery row stays
   * as-is (we don't delete or
   * overwrite it) — the replay is
   * a separate row that operators
   * can scroll through to see what
   * was manually re-fired. After
   * the replay finishes, we
   * re-fetch the deliveries list
   * so the new row appears.
   */
  const handleReplay = async (
    deliveryId: string,
    webhookId: string,
  ) => {
    if (!confirm(t("webhooks.deliveries.replayConfirm"))) return
    setReplayingId(deliveryId)
    try {
      await apiPost(
        `/api/v1/webhooks/deliveries/${deliveryId}/replay?companyId=${companyId}`,
      )
      toast.success(t("webhooks.deliveries.replaySent"))
      // Refresh the deliveries drawer
      // so the new replay row appears.
      await fetchDeliveries(companyId, webhookId)
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("webhooks.deliveries.replayFailed"),
      )
    } finally {
      setReplayingId(null)
    }
  }

  const openDeliveries = async (wh: Webhook) => {
    setDrawerWebhook(wh)
    await fetchDeliveries(companyId, wh.id)
  }

  // Tier 198 — reset an exhausted
  // delivery back to status='failed'
  // with nextRetryAt=now() so the cron
  // worker picks it up on the next tick.
  //
  // vs. handleReplay: replay creates a
  // NEW delivery row (preserves the
  // original failure as audit history).
  // Requeue modifies the SAME row in place
  // — useful when the operator knows the
  // receiver is back and just wants the
  // dead-letter off the queue. No confirm
  // dialog because requeue is reversible
  // (cron can fail it again, restoring
  // exhausted).
  const handleRequeue = async (deliveryId: string) => {
    setRequeuingId(deliveryId)
    try {
      await apiPost(
        `/api/v1/webhooks/deliveries/${deliveryId}/requeue?companyId=${companyId}`,
      )
      toast.success(t("webhooks.deadLetter.requeueSuccess"))
      // Refresh both lists — the dead-letter
      // row is now status='failed' so it
      // leaves the dead-letter view, and if
      // the drawer is open for the same
      // webhook, that view should also drop
      // the row.
      await fetchDeadLetter(companyId)
      if (drawerWebhook) {
        await fetchDeliveries(companyId, drawerWebhook.id)
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("webhooks.deadLetter.requeueFailed"),
      )
    } finally {
      setRequeuingId(null)
    }
  }

  const closeDeliveries = () => {
    setDrawerWebhook(null)
    setDeliveries([])
  }

  const copySecret = async () => {
    if (!secretDialog) return
    try {
      await navigator.clipboard.writeText(secretDialog.secret)
      setSecretCopied(true)
      setTimeout(() => setSecretCopied(false), 2500)
    } catch {
      // Clipboard API failed (e.g. insecure
      // context). User has to copy manually
      // from the <code> block. No-op.
    }
  }

  // ---- Render ----
  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
          <div className="container mx-auto px-4 py-4 flex items-center justify-between">
            <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400">
              {t("webhooks.title")}
            </h1>
            <div className="flex gap-2 items-center">
              <LanguageSwitcher />
            </div>
          </div>
        </header>
        <div className="container mx-auto px-4 py-6 max-w-5xl">
          <SkeletonTable rows={4} cols={4} />
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {t("webhooks.title")}
          </h1>
          <div className="flex gap-2 items-center">
            <Button
              variant="outline"
              onClick={() => router.push("/dashboard/settings")}
            >
              {t("webhooks.backToSettings")}
            </Button>
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-6 max-w-5xl space-y-6">
        {/* Intro card */}
        <Card>
          <CardHeader>
            <CardTitle>{t("webhooks.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {t("webhooks.subtitle")}
            </p>
            <details className="text-xs text-gray-600 dark:text-gray-400">
              <summary className="cursor-pointer font-medium">
                Technische Details
              </summary>
              <div className="mt-2 space-y-1 pl-4">
                <p>{t("webhooks.info.signature")}</p>
                <p>{t("webhooks.info.retry")}</p>
              </div>
            </details>
          </CardContent>
        </Card>

        {error && (
          <ErrorBanner
            title={t("webhooks.errors.loadFailed")}
            message={error}
          />
        )}

        {/* Webhooks list */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Aktive Webhooks ({webhooks.length})</CardTitle>
            <Button
              onClick={() => setShowCreate(true)}
              disabled={!companyId}
            >
              + {t("webhooks.create")}
            </Button>
          </CardHeader>
          <CardContent>
            {webhooks.length === 0 ? (
              <EmptyState
                title={t("webhooks.title")}
                description={t("webhooks.empty")}
                variant="default"
                fullWidth
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 px-2 font-medium">
                        {t("webhooks.name")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("webhooks.url")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("webhooks.statusLabel")}
                      </th>
                      <th className="py-2 px-2 font-medium text-right">
                        {t("webhooks.actionsLabel")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {webhooks.map((wh) => {
                      const evts = parseEvents(wh.events)
                      return (
                        <tr
                          key={wh.id}
                          className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                          data-testid="webhook-row"
                        >
                          <td className="py-3 px-2">
                            <div className="font-medium">{wh.name}</div>
                            {wh.description && (
                              <div className="text-xs text-gray-500 dark:text-gray-400">
                                {wh.description}
                              </div>
                            )}
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              {evts.length} {t("webhooks.events").toLowerCase()}
                            </div>
                          </td>
                          <td className="py-3 px-2 max-w-xs">
                            <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded break-all">
                              {wh.url}
                            </code>
                          </td>
                          <td className="py-3 px-2">
                            <span
                              className={`text-xs px-2 py-1 rounded ${statusBadgeClass(wh.status)}`}
                              data-testid="webhook-status"
                            >
                              {t(`webhooks.status.${wh.status}`)}
                            </span>
                          </td>
                          <td className="py-3 px-2 text-right">
                            <div className="flex gap-1 justify-end flex-wrap">
                              <button
                                onClick={() => handleTest(wh)}
                                disabled={testingId === wh.id || wh.status !== "active"}
                                className="text-xs px-2 py-1 border border-blue-600 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-50 disabled:opacity-50"
                                data-testid="webhook-test"
                              >
                                {testingId === wh.id
                                  ? "…"
                                  : t("webhooks.actions.test")}
                              </button>
                              <button
                                onClick={() => openDeliveries(wh)}
                                className="text-xs px-2 py-1 border border-gray-400 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50"
                                data-testid="webhook-deliveries"
                              >
                                {t("webhooks.actions.deliveries")}
                              </button>
                              <button
                                onClick={() => handleTogglePause(wh)}
                                className="text-xs px-2 py-1 border border-amber-500 text-amber-700 dark:text-amber-300 rounded hover:bg-amber-50"
                              >
                                {wh.status === "paused"
                                  ? t("webhooks.actions.resume")
                                  : t("webhooks.actions.pause")}
                              </button>
                              <button
                                onClick={() => handleDelete(wh)}
                                className="text-xs px-2 py-1 border border-red-500 text-red-700 dark:text-red-300 rounded hover:bg-red-50"
                                data-testid="webhook-delete"
                              >
                                {t("webhooks.actions.delete")}
                              </button>
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

        {/* Tier 198 — Dead-Letter Queue.
            Cross-webhook view of every
            status='exhausted' delivery for
            the company. Useful when the
            receiver was down for hours and
            47+ events stacked up across
            multiple webhooks — instead of
            opening each drawer's
            "Deliveries" tab, the operator
            sees everything in one place and
            can requeue per row. Requeue
            resets the same row to
            status='failed' so the cron
            worker picks it up on the next
            tick — no new audit row, no
            retryCount bump. */}
        <Card data-testid="dead-letter-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>
                {t("webhooks.deadLetter.title")} ({deadLetter.length})
              </CardTitle>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t("webhooks.deadLetter.subtitle")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fetchDeadLetter(companyId)}
              disabled={deadLetterLoading}
              data-testid="dead-letter-refresh"
            >
              {t("webhooks.actions.refresh")}
            </Button>
          </CardHeader>
          <CardContent>
            {deadLetterLoading && deadLetter.length === 0 ? (
              <SkeletonTable rows={3} cols={4} />
            ) : deadLetter.length === 0 ? (
              <EmptyState
                title={t("webhooks.deadLetter.empty")}
                variant="inbox"
                fullWidth
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 px-2 font-medium">
                        {t("webhooks.deadLetter.webhook")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("webhooks.deliveries.eventType")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("webhooks.deadLetter.lastError")}
                      </th>
                      <th className="py-2 px-2 font-medium">
                        {t("webhooks.deliveries.attemptedAt")}
                      </th>
                      <th className="py-2 px-2 font-medium text-right">
                        {t("webhooks.actionsLabel")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {deadLetter.map((d) => (
                      <tr
                        key={d.id}
                        className="border-b border-gray-100 dark:border-gray-800"
                        data-testid="dead-letter-row"
                      >
                        <td className="py-2 px-2 max-w-xs">
                          <div className="font-medium truncate">
                            {d.webhook.name}
                          </div>
                          <code className="text-xs text-gray-500 dark:text-gray-400 break-all">
                            {d.webhook.url}
                          </code>
                        </td>
                        <td className="py-2 px-2">
                          <code className="text-xs">{d.eventType}</code>
                        </td>
                        <td className="py-2 px-2 text-xs text-red-700 dark:text-red-300 max-w-md truncate">
                          {d.errorMessage || `HTTP ${d.statusCode ?? "—"}`}
                        </td>
                        <td className="py-2 px-2 text-xs">
                          {formatDate(d.attemptedAt)}
                        </td>
                        <td className="py-2 px-2 text-right">
                          <button
                            onClick={() => handleRequeue(d.id)}
                            disabled={requeuingId === d.id}
                            className="text-xs px-2 py-1 border border-blue-600 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-50 disabled:opacity-50"
                            data-testid="dead-letter-requeue"
                            title={t("webhooks.deadLetter.requeue")}
                          >
                            {requeuingId === d.id
                              ? t("webhooks.actions.working")
                              : t("webhooks.deadLetter.requeue")}
                          </button>
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

      {/* Create modal */}
      {showCreate && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => !creating && setShowCreate(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            data-testid="webhook-create-modal"
          >
            <div className="p-6 space-y-4">
              <h2 className="text-xl font-bold">{t("webhooks.createTitle")}</h2>

              {createError && (
                <ErrorBanner
                  title={t("webhooks.errors.createFailed")}
                  message={createError}
                />
              )}

              <form onSubmit={handleCreate} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("webhooks.name")}
                  </label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t("webhooks.namePlaceholder")}
                    data-testid="webhook-name-input"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("webhooks.url")}
                  </label>
                  <Input
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder={t("webhooks.urlPlaceholder")}
                    data-testid="webhook-url-input"
                    required
                    type="url"
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t("webhooks.urlHelp")}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("webhooks.description")}
                  </label>
                  <Input
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">
                    {t("webhooks.events")}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {t("webhooks.eventsHelp")}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded p-2">
                    {ALL_EVENT_TYPES.map((ev) => (
                      <label
                        key={ev.type}
                        className="flex items-start gap-2 p-1 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={newEvents.has(ev.type)}
                          onChange={(e) => {
                            const next = new Set(newEvents)
                            if (e.target.checked) {
                              next.add(ev.type)
                            } else {
                              next.delete(ev.type)
                            }
                            setNewEvents(next)
                          }}
                          className="mt-1"
                          data-testid={`webhook-event-${ev.key}`}
                        />
                        <div className="text-xs">
                          <div className="font-medium">
                            {t(
                              `webhooks.eventsList.${ev.key}.label`,
                            )}
                          </div>
                          <div className="text-gray-500 dark:text-gray-400">
                            {t(
                              `webhooks.eventsList.${ev.key}.description`,
                            )}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                  {newEvents.size > 0 && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {newEvents.size} ausgewählt
                    </p>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowCreate(false)}
                    disabled={creating}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      creating ||
                      !newName.trim() ||
                      !newUrl.trim() ||
                      newEvents.size === 0
                    }
                    data-testid="webhook-create-submit"
                  >
                    {creating ? "…" : t("webhooks.create")}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Secret dialog (shown ONCE after create) */}
      {secretDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-xl w-full"
            data-testid="webhook-secret-dialog"
          >
            <div className="p-6 space-y-4">
              <h2 className="text-xl font-bold">
                {t("webhooks.secretTitle")}
              </h2>
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {t("webhooks.secretBody")}
              </p>
              <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded p-3">
                <div className="text-xs text-amber-800 dark:text-amber-200 mb-1 font-medium">
                  „{secretDialog.name}"
                </div>
                <code
                  className="text-sm font-mono break-all block mb-2"
                  data-testid="webhook-secret"
                >
                  {secretDialog.secret}
                </code>
                <Button
                  size="sm"
                  onClick={copySecret}
                  data-testid="webhook-secret-copy"
                >
                  {secretCopied
                    ? "✓ " + t("webhooks.secretCopied")
                    : "📋 " + t("webhooks.secretCopied")}
                </Button>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => setSecretDialog(null)}>
                  {t("common.close")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deliveries drawer */}
      {drawerWebhook && (
        <div
          className="fixed inset-0 bg-black/40 z-50"
          onClick={closeDeliveries}
        >
          <div
            className="absolute right-0 top-0 h-full w-full max-w-2xl bg-white dark:bg-gray-800 shadow-2xl overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            data-testid="webhook-deliveries-drawer"
          >
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold">
                    {t("webhooks.deliveries.title")}
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {drawerWebhook.name}
                  </p>
                </div>
                <button
                  onClick={closeDeliveries}
                  className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              {drawerLoading ? (
                <SkeletonTable rows={5} cols={4} />
              ) : deliveries.length === 0 ? (
                <EmptyState
                  title={t("webhooks.deliveries.empty")}
                  variant="inbox"
                  fullWidth
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left border-b border-gray-200 dark:border-gray-700">
                        <th className="py-2 px-1 font-medium">
                          {t("webhooks.deliveries.eventType")}
                        </th>
                        <th className="py-2 px-1 font-medium">
                          {t("webhooks.deliveries.statusLabel")}
                        </th>
                        <th className="py-2 px-1 font-medium">
                          {t("webhooks.deliveries.statusCode")}
                        </th>
                        <th className="py-2 px-1 font-medium">
                          {t("webhooks.deliveries.duration")}
                        </th>
                        <th className="py-2 px-1 font-medium">
                          {t("webhooks.deliveries.attemptedAt")}
                        </th>
                        <th className="py-2 px-1 font-medium">
                          {t("webhooks.deliveries.nextRetry")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.map((d) => (
                        <tr
                          key={d.id}
                          className="border-b border-gray-100 dark:border-gray-800"
                          data-testid="delivery-row"
                        >
                          <td className="py-2 px-1">
                            <code className="text-xs">{d.eventType}</code>
                          </td>
                          <td className="py-2 px-1">
                            <span
                              className={`text-xs px-1.5 py-0.5 rounded ${statusBadgeClass(d.status)}`}
                            >
                              {t(
                                `webhooks.deliveries.status.${d.status}`,
                              )}
                            </span>
                          </td>
                          <td className="py-2 px-1 font-mono">
                            {d.statusCode ?? "—"}
                          </td>
                          <td className="py-2 px-1">
                            {d.durationMs !== null
                              ? `${d.durationMs} ms`
                              : "—"}
                          </td>
                          <td className="py-2 px-1">
                            {formatDate(d.attemptedAt)}
                          </td>
                          <td className="py-2 px-1">
                            {d.nextRetryAt
                              ? formatDate(d.nextRetryAt)
                              : t("webhooks.deliveries.noRetry")}
                          </td>
                          <td className="py-2 px-1 text-right">
                            <div className="flex gap-1 justify-end">
                              {/* Tier 198 — only show
                                  requeue on exhausted
                                  rows. Failed rows are
                                  already in the natural
                                  retry cycle; pending
                                  rows are fresh. */}
                              {d.status === "exhausted" && (
                                <button
                                  onClick={() => handleRequeue(d.id)}
                                  disabled={requeuingId === d.id}
                                  className="text-xs px-2 py-1 border border-emerald-500 text-emerald-700 dark:text-emerald-300 rounded hover:bg-emerald-50 disabled:opacity-50"
                                  data-testid="delivery-requeue"
                                  title={t("webhooks.deadLetter.requeue")}
                                >
                                  {requeuingId === d.id
                                    ? t("webhooks.actions.working")
                                    : t("webhooks.deadLetter.requeue")}
                                </button>
                              )}
                              <button
                                onClick={() => handleReplay(d.id, d.webhookId)}
                                disabled={replayingId === d.id}
                                className="text-xs px-2 py-1 border border-blue-500 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-50 disabled:opacity-50"
                                data-testid="delivery-replay"
                                title={t("webhooks.deliveries.replay")}
                              >
                                {replayingId === d.id
                                  ? t("webhooks.actions.replaying")
                                  : t("webhooks.deliveries.replay")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}