"use client"

// Tier 156: per-company Bemerkungstext (notes) templates.
// The Berater can drop a saved snippet into the notes
// field on /dashboard/invoices/create with one click.
//
// UX:
//   - List of templates (label + text + sortOrder +
//     "Default" badge). The order in the list = the
//     order in the dropdown on the invoice form.
//   - "+ Neue Vorlage" button → inline form (label +
//     textarea + Sort order). Save appends to the
//     list.
//   - "Bearbeiten" button per row → inline editor
//     (label + textarea + sortOrder). Save PATCHes
//     the row.
//   - "Löschen" button per row → confirm + DELETE.
//   - "↻ Auf Standard zurücksetzen" button at the top
//     wipes all custom rows + re-seeds the 5 German
//     defaults. Useful when the operator wants to
//     start over.
//
// Placeholders the operator may include in `text`:
//   {{customerName}} {{invoiceNumber}} {{dueDate}}
//   {{total}} {{companyName}}
// The dropdown on /invoices/create substitutes
// these client-side when the snippet is dropped
// into the field. Source of truth is the backend
// `NoteTemplateService.render` (Tier 156) — the
// placeholder list here is kept in sync with that
// function.

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "@/lib/api"

interface NoteTemplate {
  id: string
  companyId: string
  label: string
  text: string
  sortOrder: number
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

const PLACEHOLDER_TOKENS: { key: string; label: string }[] = [
  { key: "customerName", label: "Kundenname" },
  { key: "invoiceNumber", label: "Rechnungsnummer" },
  { key: "dueDate", label: "Fälligkeitsdatum" },
  { key: "total", label: "Gesamtbetrag" },
  { key: "companyName", label: "Firmenname" },
]

export default function NoteTemplatesSettingsPage() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  const companyId =
    typeof window !== "undefined"
      ? localStorage.getItem("companyId") || ""
      : ""

  const [templates, setTemplates] = useState<NoteTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)
  const [resetting, setResetting] = useState(false)

  // Inline create form
  const [creatingNew, setCreatingNew] = useState(false)
  const [newLabel, setNewLabel] = useState("")
  const [newText, setNewText] = useState("")
  const [newSortOrder, setNewSortOrder] = useState<string>("100")
  const [creatingBusy, setCreatingBusy] = useState(false)

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState("")
  const [editText, setEditText] = useState("")
  const [editSortOrder, setEditSortOrder] = useState<string>("0")
  const [editBusy, setEditBusy] = useState(false)

  // Click-to-insert on a textarea ref. The active
  // field is whichever the user last clicked into
  // (tracked via onFocus).
  const [activeField, setActiveField] = useState<"new" | "edit" | null>(null)
  const newTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  const load = async () => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    try {
      const list = await apiGet<NoteTemplate[]>(
        `/api/v1/note-templates?companyId=${companyId}`,
      )
      setTemplates(list || [])
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : "Vorlagen konnten nicht geladen werden",
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  const insertPlaceholder = (key: string) => {
    const token = `{{${key}}}`
    const ref = activeField === "new" ? newTextareaRef : editTextareaRef
    const target = ref.current
    if (!target) {
      // No focused field — fall back to the
      // visible text state so the user doesn't
      // lose their click.
      if (activeField === "edit") {
        setEditText(editText + token)
      } else {
        setNewText(newText + token)
      }
      return
    }
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? target.value.length
    const next = target.value.slice(0, start) + token + target.value.slice(end)
    if (activeField === "edit") {
      setEditText(next)
    } else {
      setNewText(next)
    }
    // Restore focus + caret after React commits.
    requestAnimationFrame(() => {
      target.focus()
      const caret = start + token.length
      target.setSelectionRange(caret, caret)
    })
  }

  const handleCreate = async () => {
    if (!newLabel.trim() || !newText.trim()) return
    setCreatingBusy(true)
    setError(null)
    try {
      await apiPost(`/api/v1/note-templates?companyId=${companyId}`, {
        label: newLabel.trim(),
        text: newText,
        sortOrder: parseInt(newSortOrder, 10) || 100,
      })
      setCreatingNew(false)
      setNewLabel("")
      setNewText("")
      setNewSortOrder("100")
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2500)
      await load()
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : "Vorlage konnte nicht gespeichert werden",
      )
    } finally {
      setCreatingBusy(false)
    }
  }

  const beginEdit = (tpl: NoteTemplate) => {
    setEditingId(tpl.id)
    setEditLabel(tpl.label)
    setEditText(tpl.text)
    setEditSortOrder(String(tpl.sortOrder))
  }

  const handleUpdate = async (id: string) => {
    if (!editLabel.trim() || !editText.trim()) return
    setEditBusy(true)
    setError(null)
    try {
      await apiPatch(
        `/api/v1/note-templates/${id}?companyId=${companyId}`,
        {
          label: editLabel.trim(),
          text: editText,
          sortOrder: parseInt(editSortOrder, 10) || 0,
        },
      )
      setEditingId(null)
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 2500)
      await load()
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : "Vorlage konnte nicht aktualisiert werden",
      )
    } finally {
      setEditBusy(false)
    }
  }

  const handleDelete = async (tpl: NoteTemplate) => {
    if (!confirm(`Vorlage "${tpl.label}" wirklich löschen?`)) return
    setError(null)
    try {
      await apiDelete(
        `/api/v1/note-templates/${tpl.id}?companyId=${companyId}`,
      )
      await load()
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : "Vorlage konnte nicht gelöscht werden",
      )
    }
  }

  const handleResetDefaults = async () => {
    if (
      !confirm(
        "Alle Vorlagen löschen und die 5 Standard-Vorlagen neu anlegen?",
      )
    )
      return
    setResetting(true)
    setError(null)
    try {
      await apiPost(
        `/api/v1/note-templates/reset-defaults?companyId=${companyId}`,
        {},
      )
      await load()
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : "Standard-Vorlagen konnten nicht wiederhergestellt werden",
      )
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/dashboard/settings")}
              data-testid="note-templates-back"
            >
              ← {t("common2.settings") || "Einstellungen"}
            </Button>
            <h1 className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
              {t("noteTemplates.title") || "Bemerkungsvorlagen"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        {error && (
          <div
            className="p-3 rounded bg-red-50 border border-red-200 text-red-800 dark:bg-red-900/30 dark:border-red-700 dark:text-red-200 text-sm"
            data-testid="note-templates-error"
          >
            {error}
          </div>
        )}
        {savedOk && (
          <div
            className="p-3 rounded bg-green-50 border border-green-200 text-green-800 dark:bg-green-900/30 dark:border-green-700 dark:text-green-200 text-sm"
            data-testid="note-templates-saved-ok"
          >
            ✓ {t("common2.saved") || "Gespeichert"}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between flex-wrap gap-2">
              <span>
                {t("noteTemplates.subtitle") ||
                  "Gespeicherte Textbausteine für das Bemerkungs-Feld auf der Rechnungs-Erstellung."}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleResetDefaults}
                  disabled={resetting || loading}
                  data-testid="note-templates-reset-defaults"
                >
                  ↻ {t("noteTemplates.resetDefaults") || "Standard wiederherstellen"}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setCreatingNew((v) => !v)
                    setEditingId(null)
                    setActiveField("new")
                  }}
                  data-testid="note-templates-new-toggle"
                >
                  + {t("noteTemplates.new") || "Neue Vorlage"}
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {creatingNew && (
              <div
                className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-2 bg-gray-50 dark:bg-gray-900/40"
                data-testid="note-templates-new-form"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {t("noteTemplates.labelLabel") || "Button-Beschriftung"}
                    </label>
                    <Input
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      onFocus={() => setActiveField("new")}
                      placeholder="z.B. Skonto 3%"
                      data-testid="note-templates-new-label"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      {t("noteTemplates.sortOrderLabel") || "Reihenfolge"}
                    </label>
                    <Input
                      type="number"
                      value={newSortOrder}
                      onChange={(e) => setNewSortOrder(e.target.value)}
                      onFocus={() => setActiveField("new")}
                      data-testid="note-templates-new-sort"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {t("noteTemplates.textLabel") || "Text"}
                  </label>
                  <textarea
                    ref={newTextareaRef}
                    value={newText}
                    onChange={(e) => setNewText(e.target.value)}
                    onFocus={() => setActiveField("new")}
                    rows={4}
                    className="w-full px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
                    data-testid="note-templates-new-text"
                  />
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="text-xs text-gray-500">
                    {t("noteTemplates.placeholders") || "Platzhalter:"}
                  </span>
                  {PLACEHOLDER_TOKENS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => insertPlaceholder(p.key)}
                      className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                      data-testid={`note-templates-placeholder-${p.key}`}
                    >
                      {`{{${p.key}}}`}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCreatingNew(false)}
                    disabled={creatingBusy}
                    data-testid="note-templates-new-cancel"
                  >
                    {t("common2.cancel") || "Abbrechen"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleCreate}
                    disabled={creatingBusy || !newLabel.trim() || !newText.trim()}
                    data-testid="note-templates-new-save"
                  >
                    {t("common2.save") || "Speichern"}
                  </Button>
                </div>
              </div>
            )}

            {loading ? (
              <p className="text-sm text-gray-500" data-testid="note-templates-loading">
                ⏳ {t("common2.loading") || "Lade…"}
              </p>
            ) : templates.length === 0 ? (
              <p
                className="text-sm text-gray-500"
                data-testid="note-templates-empty"
              >
                {t("noteTemplates.empty") || "Noch keine Vorlagen."}
              </p>
            ) : (
              <ul className="space-y-2" data-testid="note-templates-list">
                {templates.map((tpl) =>
                  editingId === tpl.id ? (
                    <li
                      key={tpl.id}
                      className="border border-blue-300 dark:border-blue-600 rounded p-3 space-y-2 bg-blue-50/30 dark:bg-blue-900/20"
                      data-testid={`note-templates-row-${tpl.id}`}
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs font-medium mb-1">
                            {t("noteTemplates.labelLabel") || "Button-Beschriftung"}
                          </label>
                          <Input
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            onFocus={() => setActiveField("edit")}
                            data-testid="note-templates-edit-label"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">
                            {t("noteTemplates.sortOrderLabel") || "Reihenfolge"}
                          </label>
                          <Input
                            type="number"
                            value={editSortOrder}
                            onChange={(e) => setEditSortOrder(e.target.value)}
                            onFocus={() => setActiveField("edit")}
                            data-testid="note-templates-edit-sort"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1">
                          {t("noteTemplates.textLabel") || "Text"}
                        </label>
                        <textarea
                          ref={editTextareaRef}
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          onFocus={() => setActiveField("edit")}
                          rows={4}
                          className="w-full px-3 py-2 border rounded bg-white dark:bg-gray-700 dark:border-gray-600 text-sm"
                          data-testid="note-templates-edit-text"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2 items-center">
                        <span className="text-xs text-gray-500">
                          {t("noteTemplates.placeholders") || "Platzhalter:"}
                        </span>
                        {PLACEHOLDER_TOKENS.map((p) => (
                          <button
                            key={p.key}
                            type="button"
                            onClick={() => insertPlaceholder(p.key)}
                            className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                            data-testid={`note-templates-edit-placeholder-${p.key}`}
                          >
                            {`{{${p.key}}}`}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditingId(null)}
                          disabled={editBusy}
                          data-testid="note-templates-edit-cancel"
                        >
                          {t("common2.cancel") || "Abbrechen"}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleUpdate(tpl.id)}
                          disabled={editBusy || !editLabel.trim() || !editText.trim()}
                          data-testid="note-templates-edit-save"
                        >
                          {t("common2.save") || "Speichern"}
                        </Button>
                      </div>
                    </li>
                  ) : (
                    <li
                      key={tpl.id}
                      className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-white dark:bg-gray-800 flex items-start justify-between gap-2"
                      data-testid={`note-templates-row-${tpl.id}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">
                            {tpl.label}
                          </span>
                          {tpl.isDefault && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                              {t("noteTemplates.badgeDefault") || "Standard"}
                            </span>
                          )}
                          <span className="text-xs text-gray-400">
                            #{tpl.sortOrder}
                          </span>
                        </div>
                        <p className="text-xs text-gray-600 dark:text-gray-300 mt-1 whitespace-pre-line break-words">
                          {tpl.text}
                        </p>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditingId(tpl.id)
                            setCreatingNew(false)
                            setActiveField("edit")
                          }}
                          data-testid="note-templates-row-edit"
                        >
                          ✏ {t("common2.edit") || "Bearbeiten"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleDelete(tpl)}
                          data-testid="note-templates-row-delete"
                        >
                          🗑 {t("common2.delete") || "Löschen"}
                        </Button>
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}