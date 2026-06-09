"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut } from "@/lib/api"

type Level = "first" | "second" | "final"

interface ReminderTemplate {
  id: string
  level: Level
  subject: string
  body: string
  isDefault: boolean
}

const LEVEL_LABEL: Record<Level, { de: string; en: string; zh: string }> = {
  first: { de: "1. Mahnung (Erinnerung)", en: "1st Reminder", zh: "第 1 次催款" },
  second: { de: "2. Mahnung", en: "2nd Reminder", zh: "第 2 次催款" },
  final: { de: "Letzte Mahnung (Inkasso-Androhung)", en: "Final Reminder", zh: "最后催款" },
}

const PLACEHOLDERS = [
  { key: "customerName", de: "Kundenname", en: "Customer name" },
  { key: "invoiceNumber", de: "Rechnungsnummer", en: "Invoice number" },
  { key: "totalAmount", de: "Gesamtbetrag (EUR)", en: "Total amount (EUR)" },
  { key: "dueDateFormatted", de: "Fälligkeitsdatum (formatiert)", en: "Due date (formatted)" },
  { key: "daysOverdue", de: "Tage überfällig", en: "Days overdue" },
  { key: "bankInfo", de: "Bankverbindung", en: "Bank details" },
  { key: "companyName", de: "Eigener Firmenname", en: "Your company name" },
]

export default function ReminderTemplatesPage() {
  const router = useRouter()
  const { t } = useI18n()
  const [templates, setTemplates] = useState<ReminderTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Level | null>(null)
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    apiGet<ReminderTemplate[]>(`/reminders/templates?companyId=${companyId}`)
      .then((d) => setTemplates(d || []))
      .catch((err) => console.error("Templates load failed:", err))
      .finally(() => setLoading(false))
  }, [router])

  const openEdit = (tpl: ReminderTemplate) => {
    setEditing(tpl.level)
    setSubject(tpl.subject)
    setBody(tpl.body)
    setSaved(null)
    setPreview(null)
  }

  const closeEdit = () => {
    setEditing(null)
    setSubject("")
    setBody("")
    setPreview(null)
  }

  const loadPreview = async () => {
    if (!editing) return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setPreviewLoading(true)
    try {
      const p = await apiGet<{ subject: string; body: string }>(
        `/reminders/templates/${editing}/preview?companyId=${companyId}`
      )
      setPreview(p)
    } catch (e) {
      console.error("preview failed:", e)
    } finally {
      setPreviewLoading(false)
    }
  }

  const save = async () => {
    if (!editing) return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setSaving(true)
    setSaved(null)
    try {
      const updated = await apiPut<ReminderTemplate>(
        `/reminders/templates/${editing}?companyId=${companyId}`,
        { subject, body }
      )
      setTemplates((prev) => prev.map((t) => (t.level === editing ? updated : t)))
      setSaved(t("reminder.templates.saved") || "Gespeichert")
    } catch (e: any) {
      console.error("save failed:", e)
      setSaved(`${t("common.error") || "Fehler"}: ${e?.message || ""}`)
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    if (!editing) return
    if (!confirm(t("reminder.templates.confirmReset") || "Auf Standard zurücksetzen?")) return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      const fresh = await apiPost<ReminderTemplate>(
        `/reminders/templates/${editing}/reset?companyId=${companyId}`
      )
      setTemplates((prev) => prev.map((t) => (t.level === editing ? fresh : t)))
      setSubject(fresh.subject)
      setBody(fresh.body)
      setSaved(t("reminder.templates.resetDone") || "Auf Standard zurückgesetzt")
      setPreview(null)
    } catch (e) {
      console.error("reset failed:", e)
    }
  }

  const insertPlaceholder = (key: string) => {
    if (!editing) return
    const token = `{{${key}}}`
    setBody((b) => b + token)
  }

  // Re-fetch preview whenever subject/body change, but
  // debounce so the server isn't hammered while typing.
  useEffect(() => {
    if (!editing) return
    const h = setTimeout(loadPreview, 500)
    return () => clearTimeout(h)
  }, [editing, subject, body])

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              {t("reminder.templates.title") || "Mahnung-Vorlagen"}
            </h1>
            <p className="text-gray-500 mt-1">
              {t("reminder.templates.subtitle") || "Bearbeiten Sie die E-Mail-Vorlagen für 1./2./Letzte Mahnung"}
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard/reminders")}>
              {t("common.back") || "Zurück"}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-500">{t("common.loading") || "Lädt..."}</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(["first", "second", "final"] as Level[]).map((level) => {
              const tpl = templates.find((t) => t.level === level)
              if (!tpl) return null
              const isEditing = editing === level
              return (
                <Card key={level} className={isEditing ? "ring-2 ring-blue-500" : ""}>
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span>{LEVEL_LABEL[level].de}</span>
                      {tpl.isDefault ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-normal">
                          {t("reminder.templates.default") || "Standard"}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-normal">
                          {t("reminder.templates.customized") || "Angepasst"}
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {!isEditing ? (
                      <>
                        <p className="text-sm font-medium text-gray-700">Betreff:</p>
                        <p className="text-sm mb-3 font-mono">{tpl.subject}</p>
                        <p className="text-sm font-medium text-gray-700">Inhalt:</p>
                        <pre className="text-xs bg-gray-50 p-3 rounded border whitespace-pre-wrap max-h-60 overflow-y-auto">
                          {tpl.body}
                        </pre>
                        <div className="mt-4 flex gap-2">
                          <Button size="sm" onClick={() => openEdit(tpl)}>
                            {t("common.edit") || "Bearbeiten"}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            {t("reminder.templates.subjectLabel") || "Betreff"}
                          </label>
                          <input
                            type="text"
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                            className="w-full border rounded px-3 py-2 text-sm font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">
                            {t("reminder.templates.bodyLabel") || "Inhalt"}
                          </label>
                          <textarea
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            rows={12}
                            className="w-full border rounded px-3 py-2 text-sm font-mono"
                          />
                        </div>
                        <div>
                          <p className="text-xs text-gray-500 mb-1">
                            {t("reminder.templates.placeholdersHint") || "Platzhalter einfügen:"}
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {PLACEHOLDERS.map((p) => (
                              <button
                                key={p.key}
                                type="button"
                                onClick={() => insertPlaceholder(p.key)}
                                className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded border"
                                title={p.de}
                              >
                                {`{{${p.key}}}`}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Preview */}
                        <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm">
                          <p className="font-medium mb-2 text-blue-900">
                            {t("reminder.templates.preview") || "Vorschau"}:
                          </p>
                          {previewLoading ? (
                            <p className="text-xs text-gray-500">{t("common.loading") || "Lädt..."}</p>
                          ) : preview ? (
                            <>
                              <p className="font-medium text-xs text-gray-500">Betreff:</p>
                              <p className="text-sm mb-2">{preview.subject}</p>
                              <p className="font-medium text-xs text-gray-500">Inhalt:</p>
                              <pre className="text-xs whitespace-pre-wrap max-h-40 overflow-y-auto">
                                {preview.body}
                              </pre>
                            </>
                          ) : (
                            <p className="text-xs text-gray-500">—</p>
                          )}
                        </div>

                        {saved && (
                          <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
                            {saved}
                          </div>
                        )}

                        <div className="flex gap-2 pt-2">
                          <Button onClick={save} disabled={saving}>
                            {saving ? (t("common.saving") || "Speichert...") : (t("common.save") || "Speichern")}
                          </Button>
                          <Button variant="outline" onClick={reset}>
                            {t("common.reset") || "Zurücksetzen"}
                          </Button>
                          <Button variant="ghost" onClick={closeEdit}>
                            {t("common.cancel") || "Abbrechen"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
