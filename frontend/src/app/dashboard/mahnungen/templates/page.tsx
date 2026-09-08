"use client"

// Tier 151: per-company Mahnung e-mail template editor.
//
// The backend already had the full CRUD surface
// (GET/PUT /api/v1/reminders/templates, GET
// /preview, POST /reset) — the gap was a UI to
// drive it. The Berater's question: "Can I change
// the wording of our 1. Mahnung so it's less
// aggressive?" This page is the answer.
//
// UX:
//   - 3 tabs (first / second / final) so the user
//     can edit each level independently
//   - Subject input + body textarea
//   - "Platzhalter" sidebar listing the 7 tokens
//     the backend resolves. Click → inserts at
//     the cursor position in the active field.
//   - "Vorschau" button calls the preview
//     endpoint and shows the rendered subject +
//     body in a read-only card next to the editor
//   - Save / Reset to default buttons
//   - "Standardvorlage" / "Angepasste Vorlage"
//     badge so the user knows whether the level
//     is at the default text
//
// We track per-level "dirty" state: if the user
// edits the body and then switches tabs, the
// unsaved changes are lost (with a confirm() if
// the user really wants to switch). Saving before
// switching avoids the prompt.

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, ApiError } from "@/lib/api"

type Level = "first" | "second" | "final"

interface Template {
  id: string
  companyId: string
  level: Level
  subject: string
  body: string
  isDefault: boolean
}

// The 7 placeholders the backend resolves. Listed
// here (in addition to being read from the rendered
// preview) so the editor can show them as
// "click-to-insert" tokens. Source of truth is
// reminder.service.renderForInvoice() — keep this
// list in sync if the backend adds a new token.
const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: "customerName", label: "Kundenname" },
  { key: "invoiceNumber", label: "Rechnungsnummer" },
  { key: "totalAmount", label: "Betrag (EUR)" },
  { key: "dueDateFormatted", label: "Fälligkeitsdatum" },
  { key: "daysOverdue", label: "Tage überfällig" },
  { key: "bankInfo", label: "Bankverbindung" },
  { key: "companyName", label: "Firmenname" },
]

const LEVELS: Level[] = ["first", "second", "final"]

export default function MahnungTemplatesPage() {
  const router = useRouter()
  const { t } = useI18n()
  const [activeLevel, setActiveLevel] = useState<Level>("first")
  // Per-level cache so switching tabs doesn't
  // re-fetch (and so unsaved edits are preserved
  // when switching — we just compare with the
  // last-saved snapshot to compute dirty).
  const [templates, setTemplates] = useState<Record<Level, Template | null>>({
    first: null,
    second: null,
    final: null,
  })
  // Per-level draft state (what the editor is
  // currently showing). Mirrored from `templates`
  // on tab switch, locally edited as the user
  // types.
  const [drafts, setDrafts] = useState<Record<Level, { subject: string; body: string }>>({
    first: { subject: "", body: "" },
    second: { subject: "", body: "" },
    final: { subject: "", body: "" },
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [resetOk, setResetOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  // Refs for the inputs so the placeholder
  // "insert at cursor" handler can focus + set
  // selection. We keep one ref per level for
  // body (textarea) and one for subject (input).
  const subjectRefs = useRef<Record<Level, HTMLInputElement | null>>({
    first: null,
    second: null,
    final: null,
  })
  const bodyRefs = useRef<Record<Level, HTMLTextAreaElement | null>>({
    first: null,
    second: null,
    final: null,
  })

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    // Fetch all 3 levels in parallel — the page
    // shows the level tabs immediately and only
    // displays the active level's editor. We
    // don't want a tab switch to trigger a
    // network roundtrip.
    Promise.all(
      LEVELS.map((lvl) =>
        apiGet<Template>(
          `/api/v1/reminders/templates/${lvl}?companyId=${companyId}`,
        ).catch((err) => {
          // A 5xx here would block the whole page.
          // Log + return null so the rest of the
          // levels still load. The user can
          // retry the failed tab.
          console.error(`Failed to load ${lvl} template:`, err)
          return null
        }),
      ),
    ).then(([first, second, final]) => {
      const next: Record<Level, Template | null> = { first, second, final }
      setTemplates(next)
      // Seed drafts from the loaded templates.
      const seed: Record<Level, { subject: string; body: string }> = {
        first: { subject: "", body: "" },
        second: { subject: "", body: "" },
        final: { subject: "", body: "" },
      }
      LEVELS.forEach((lvl) => {
        const t = next[lvl]
        if (t) {
          seed[lvl] = { subject: t.subject, body: t.body }
        }
      })
      setDrafts(seed)
      setLoading(false)
    })
  }, [router])

  const current = templates[activeLevel]
  const currentDraft = drafts[activeLevel]
  // Dirty = draft differs from the saved template.
  // Used to (a) show a "Save" hint when the user
  // has unsaved changes, and (b) prompt before
  // tab switch.
  const isDirty =
    !!current &&
    (currentDraft.subject !== current.subject ||
      currentDraft.body !== current.body)

  // When the user switches tabs: if the current
  // tab is dirty, ask "discard changes?". Saving
  // first avoids the prompt.
  const handleTabSwitch = (next: Level) => {
    if (next === activeLevel) return
    if (isDirty) {
      const ok = window.confirm(
        "Ungespeicherte Änderungen verwerfen?",
      )
      if (!ok) return
    }
    setActiveLevel(next)
    setPreview(null)
    setPreviewError(null)
  }

  // Insert a placeholder at the current cursor
  // position of the active field (subject or
  // body). If the field has no selection, append
  // to the end. The token is wrapped in
  // `{{...}}` exactly as the backend expects.
  const insertPlaceholder = (key: string) => {
    const token = `{{${key}}}`
    const target = document.activeElement
    // Prefer the field the user is currently in.
    // Fall back to body of the active level.
    let input: HTMLInputElement | HTMLTextAreaElement | null = null
    if (target === subjectRefs.current[activeLevel]) {
      input = subjectRefs.current[activeLevel]
    } else if (target === bodyRefs.current[activeLevel]) {
      input = bodyRefs.current[activeLevel]
    } else {
      input = bodyRefs.current[activeLevel] || subjectRefs.current[activeLevel]
    }
    if (!input) return
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? input.value.length
    const before = input.value.slice(0, start)
    const after = input.value.slice(end)
    const newValue = before + token + after
    const isSubject = input === subjectRefs.current[activeLevel]
    setDrafts((prev) => ({
      ...prev,
      [activeLevel]: {
        ...prev[activeLevel],
        [isSubject ? "subject" : "body"]: newValue,
      },
    }))
    // Restore the cursor position after React
    // commits the new value. We schedule this in
    // a microtask via requestAnimationFrame so
    // it runs after the DOM is updated.
    requestAnimationFrame(() => {
      input!.focus()
      const pos = start + token.length
      input!.setSelectionRange(pos, pos)
    })
  }

  const handleSave = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId || !current) return
    setSaving(true)
    setError(null)
    setSavedOk(false)
    try {
      const updated = await apiPut<Template>(
        `/api/v1/reminders/templates/${activeLevel}?companyId=${companyId}`,
        {
          subject: currentDraft.subject,
          body: currentDraft.body,
        },
      )
      setTemplates((prev) => ({ ...prev, [activeLevel]: updated }))
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 3000)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Speichern fehlgeschlagen"
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    if (!window.confirm(t("mahnung.templatesResetConfirm"))) return
    setResetting(true)
    setError(null)
    setResetOk(false)
    try {
      const updated = await apiPost<Template>(
        `/api/v1/reminders/templates/${activeLevel}/reset?companyId=${companyId}`,
        {},
      )
      setTemplates((prev) => ({ ...prev, [activeLevel]: updated }))
      setDrafts((prev) => ({
        ...prev,
        [activeLevel]: { subject: updated.subject, body: updated.body },
      }))
      setPreview(null)
      setResetOk(true)
      setTimeout(() => setResetOk(false), 3000)
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Zurücksetzen fehlgeschlagen"
      setError(msg)
    } finally {
      setResetting(false)
    }
  }

  const handlePreview = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setPreviewLoading(true)
    setPreviewError(null)
    setPreview(null)
    try {
      // The preview endpoint renders the SAVED
      // template (not the draft). For a draft
      // preview we'd need a write-then-read —
      // too disruptive. The user can save first
      // then preview, or accept that the preview
      // is one step behind.
      const res = await apiGet<{ subject: string; body: string }>(
        `/api/v1/reminders/templates/${activeLevel}/preview?companyId=${companyId}`,
      )
      setPreview(res)
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : t("mahnung.templatesPreviewError")
      setPreviewError(msg)
    } finally {
      setPreviewLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/dashboard/mahnungen")}
              data-testid="mahnung-templates-back"
            >
              ← {t("nav.reminders") || "Mahnungen"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/dashboard/mahnungen/settings")}
              data-testid="mahnung-templates-back-settings"
            >
              ⚙ {t("mahnung.settings")}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
            <Button
              variant="outline"
              onClick={() => {
                localStorage.clear()
                router.push("/login")
              }}
            >
              {t("dashboard.logout")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold" data-testid="mahnung-templates-title">
            {t("mahnung.templatesTitle")}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t("mahnung.templatesSubtitle")}
          </p>
        </div>

        {/* Level tabs */}
        <div className="flex flex-wrap gap-2 mb-4" data-testid="mahnung-templates-tabs">
          {LEVELS.map((lvl) => {
            const isActive = lvl === activeLevel
            const labelKey =
              lvl === "first"
                ? "mahnung.templatesLevelFirst"
                : lvl === "second"
                ? "mahnung.templatesLevelSecond"
                : "mahnung.templatesLevelFinal"
            return (
              <Button
                key={lvl}
                variant={isActive ? "default" : "outline"}
                size="sm"
                onClick={() => handleTabSwitch(lvl)}
                data-testid={`mahnung-templates-tab-${lvl}`}
                data-active={isActive ? "true" : "false"}
              >
                {t(labelKey)}
              </Button>
            )
          })}
        </div>

        {loading ? (
          <Card>
            <CardContent className="p-6 text-sm text-gray-500">Lade Vorlagen…</CardContent>
          </Card>
        ) : !current ? (
          <Card>
            <CardContent className="p-6 text-sm text-red-600">
              Vorlage konnte nicht geladen werden. Bitte erneut versuchen.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Editor — 2/3 width on desktop */}
            <div className="lg:col-span-2 space-y-4">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <CardTitle>{t("mahnung.templatesSubject")}</CardTitle>
                    <span
                      className={
                        "text-xs px-2 py-0.5 rounded-full " +
                        (current.isDefault
                          ? "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                          : "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200")
                      }
                      data-testid="mahnung-templates-badge"
                    >
                      {current.isDefault
                        ? t("mahnung.templatesIsDefault")
                        : t("mahnung.templatesIsCustom")}
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <input
                    ref={(el) => {
                      subjectRefs.current[activeLevel] = el
                    }}
                    type="text"
                    value={currentDraft.subject}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [activeLevel]: { ...prev[activeLevel], subject: e.target.value },
                      }))
                    }
                    className="w-full px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 text-sm"
                    data-testid="mahnung-templates-subject"
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t("mahnung.templatesBody")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <textarea
                    ref={(el) => {
                      bodyRefs.current[activeLevel] = el
                    }}
                    value={currentDraft.body}
                    onChange={(e) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [activeLevel]: { ...prev[activeLevel], body: e.target.value },
                      }))
                    }
                    rows={14}
                    className="w-full px-3 py-2 border rounded-md bg-white dark:bg-gray-800 dark:border-gray-700 text-sm font-mono"
                    data-testid="mahnung-templates-body"
                  />
                </CardContent>
              </Card>

              <div className="flex flex-wrap gap-2 items-center">
                <Button
                  onClick={handleSave}
                  disabled={saving || !isDirty}
                  data-testid="mahnung-templates-save"
                >
                  {saving ? "…" : t("mahnung.templatesSave")}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleReset}
                  disabled={resetting}
                  data-testid="mahnung-templates-reset"
                >
                  {resetting ? "…" : t("mahnung.templatesReset")}
                </Button>
                <Button
                  variant="outline"
                  onClick={handlePreview}
                  disabled={previewLoading}
                  data-testid="mahnung-templates-preview"
                >
                  {previewLoading ? "…" : t("mahnung.templatesPreview")}
                </Button>
                {savedOk && (
                  <span className="text-sm text-green-600 dark:text-green-400" data-testid="mahnung-templates-saved-ok">
                    ✓ {t("mahnung.templatesSavedOk")}
                  </span>
                )}
                {resetOk && (
                  <span className="text-sm text-green-600 dark:text-green-400">
                    ✓ {t("mahnung.templatesResetOk")}
                  </span>
                )}
                {isDirty && !savedOk && !resetOk && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">
                    ● Ungespeicherte Änderungen
                  </span>
                )}
                {error && (
                  <span className="text-sm text-red-600 dark:text-red-400" data-testid="mahnung-templates-error">
                    {error}
                  </span>
                )}
              </div>
            </div>

            {/* Sidebar — 1/3 width on desktop */}
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {t("mahnung.templatesPlaceholders")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {t("mahnung.templatesPlaceholderHint")}
                  </p>
                  <ul className="space-y-1.5" data-testid="mahnung-templates-placeholders">
                    {PLACEHOLDERS.map((p) => (
                      <li key={p.key}>
                        <button
                          type="button"
                          onClick={() => insertPlaceholder(p.key)}
                          className="w-full text-left px-2 py-1.5 text-sm rounded border border-gray-200 dark:border-gray-700 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-between gap-2"
                          data-testid={`mahnung-templates-placeholder-${p.key}`}
                        >
                          <span className="font-mono text-blue-700 dark:text-blue-300 text-xs">
                            {`{{${p.key}}}`}
                          </span>
                          <span className="text-gray-500 dark:text-gray-400 text-xs">
                            {p.label}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              {/* Preview panel — only shows after the user clicks Vorschau */}
              {(preview || previewError || previewLoading) && (
                <Card data-testid="mahnung-templates-preview-card">
                  <CardHeader>
                    <CardTitle className="text-base">
                      {t("mahnung.templatesPreview")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {previewLoading && (
                      <p className="text-sm text-gray-500">…</p>
                    )}
                    {previewError && (
                      <p className="text-sm text-red-600 dark:text-red-400" data-testid="mahnung-templates-preview-error">
                        {previewError}
                      </p>
                    )}
                    {preview && (
                      <>
                        <div>
                          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            {t("mahnung.templatesPreviewSubject")}
                          </div>
                          <div
                            className="text-sm font-semibold"
                            data-testid="mahnung-templates-preview-subject"
                          >
                            {preview.subject}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                            {t("mahnung.templatesPreviewBody")}
                          </div>
                          <pre
                            className="text-sm whitespace-pre-wrap font-sans"
                            data-testid="mahnung-templates-preview-body"
                          >
                            {preview.body}
                          </pre>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  )
}