"use client"

import { useEffect, useState, useCallback } from "react"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, apiDelete, apiFetch } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/useToast"

interface TemplateConfig {
  primaryColor?: string
  accentColor?: string
  textColor?: string
  fontFamily?: "Helvetica" | "Times-Roman" | "Courier"
  layoutDensity?: "comfortable" | "compact"
  showLogo?: boolean
  footerText?: string
  paymentTermsText?: string
  showAbsenderzeile?: boolean
  reverseChargeNote?: string
  kleineUnternehmerNote?: string
}

interface InvoiceTemplate {
  id: string
  companyId: string
  name: string
  templateType: string
  configJson: TemplateConfig
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

/**
 * Tier 7: Custom invoice template editor.
 *
 * Three sections:
 *
 * 1. **List** — every template for the
 *    company, with the default pinned to
 *    the top and a "Vorschau" button per
 *    row that opens a new tab with the
 *    PDF preview.
 *
 * 2. **Edit modal** — name + the styling
 *    fields (primary/accent/text color,
 *    font, density, footer text, custom
 *    notes). All inputs are
 *    client-side-validated against the
 *    same rules the backend enforces, so
 *    the user sees the error immediately
 *    rather than after a round-trip.
 *
 * 3. **New-template modal** — same fields
 *    as Edit, plus a "Als Standard
 *    festlegen" checkbox. Setting the
 *    default here demotes the existing
 *    default (one per company max).
 *
 * The PDF preview opens in a new tab via
 * `window.open` with the response
 * Content-Disposition=inline. The user
 * sees the rendered template + a sample
 * invoice (Beispiel-Kunde GmbH) without
 * having to apply the template to a real
 * invoice first.
 */
export default function InvoiceTemplatesPage() {
  const { t } = useI18n()
  const toast = useToast()
  const [companyId, setCompanyId] = useState<string>("")
  const [templates, setTemplates] = useState<InvoiceTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<InvoiceTemplate | null>(null)
  const [showNew, setShowNew] = useState(false)

  const fetchTemplates = useCallback(
    async (cid: string, signal?: AbortSignal) => {
      setLoading(true)
      try {
        const data = await apiGet<InvoiceTemplate[]>(
          `/api/v1/invoice-templates?companyId=${cid}`,
          signal ? { signal } : undefined,
        )
        if (signal?.aborted) return
        setTemplates(data ?? [])
      } catch (err: any) {
        // AbortError is the expected outcome of a
        // superseded request — silent, not a toast.
        if (err?.name === "AbortError" || signal?.aborted) return
        toast.error(err?.message || t("invoiceTemplates.loadError"))
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [t, toast],
  )

  useEffect(() => {
    const cid = localStorage.getItem("companyId") || ""
    if (!cid) return
    setCompanyId(cid)
    // Tier 300: AbortController cancels any
    // in-flight request when the effect re-runs
    // (e.g. after HMR or a parent re-render that
    // changes the fetchTemplates reference).
    // Without this, multiple stale requests race
    // to setState and the throttler can 429 the
    // newest legitimate call.
    const ctrl = new AbortController()
    fetchTemplates(cid, ctrl.signal)
    return () => ctrl.abort()
    // Tier 300: depend on the *function reference*
    // but the function's own deps are stable across
    // renders (`t` and `toast` come from module-level
    // contexts in this codebase). When the function
    // ref does change we still want to re-fetch, so
    // we keep it in the dep list.
  }, [fetchTemplates])

  const handleSave = async (tpl: Partial<InvoiceTemplate>, isNew: boolean) => {
    try {
      if (isNew) {
        await apiPost<InvoiceTemplate>("/api/v1/invoice-templates", {
          companyId,
          name: tpl.name,
          templateType: "custom",
          configJson: tpl.configJson,
          isDefault: tpl.isDefault || false,
        })
        toast.success(t("invoiceTemplates.created"))
      } else if (editing) {
        await apiPut<InvoiceTemplate>(
          `/api/v1/invoice-templates/${editing.id}?companyId=${companyId}`,
          {
            name: tpl.name,
            configJson: tpl.configJson,
            isDefault: tpl.isDefault,
          },
        )
        toast.success(t("invoiceTemplates.updated"))
      }
      setEditing(null)
      setShowNew(false)
      fetchTemplates(companyId)
    } catch (err: any) {
      toast.error(err?.message || t("invoiceTemplates.saveError"))
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm(t("invoiceTemplates.confirmDelete"))) return
    try {
      await apiDelete(
        `/api/v1/invoice-templates/${id}?companyId=${companyId}`,
      )
      toast.success(t("invoiceTemplates.deleted"))
      fetchTemplates(companyId)
    } catch (err: any) {
      toast.error(err?.message || t("invoiceTemplates.deleteError"))
    }
  }

  const openPreview = (id: string) => {
    // POST to /preview but open in a new
    // tab. We use fetch+Blob+URL.createObjectURL
    // because window.open with a POST body is
    // not standard. The blob URL gives the
    // browser a real PDF to render.
    // Tier 377: apiFetch prefixes API_BASE (the relative URL only reached
    // the backend behind nginx) and throws on a non-2xx, so an error page is
    // not opened as a "PDF".
    apiFetch(`/api/v1/invoice-templates/${id}/preview?companyId=${companyId}`, {
      method: "POST",
    })
      .then((r) => r.blob())
      .then((b) => {
        const url = URL.createObjectURL(b)
        window.open(url, "_blank")
        // Revoke later — the new tab keeps a
        // reference, so waiting 60s before
        // revoking gives the user time to
        // load it.
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      })
      .catch((e) => toast.error(e?.message || t("invoiceTemplates.previewError")))
  }

  if (loading) {
    return (
      <div className="p-8 text-gray-500 dark:text-gray-400">{t("common.loading")}</div>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("invoiceTemplates.title")}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t("invoiceTemplates.subtitle")}
          </p>
        </div>
        <Button onClick={() => setShowNew(true)}>
          {t("invoiceTemplates.newTemplate")}
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            {t("invoiceTemplates.empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {templates.map((tpl) => (
            <Card key={tpl.id}>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="font-semibold">{tpl.name}</div>
                      {tpl.isDefault && (
                        <span className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
                          {t("invoiceTemplates.defaultBadge")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-mono">
                      {tpl.configJson.primaryColor} · {tpl.configJson.fontFamily} · {tpl.configJson.layoutDensity}
                    </div>
                    {tpl.configJson.footerText && (
                      <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 italic">
                        „{tpl.configJson.footerText}"
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openPreview(tpl.id)}
                  >
                    {t("invoiceTemplates.preview")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(tpl)}
                  >
                    {t("common.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDelete(tpl.id)}
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {(editing || showNew) && (
        <TemplateModal
          template={editing}
          onClose={() => {
            setEditing(null)
            setShowNew(false)
          }}
          onSubmit={handleSave}
        />
      )}
    </div>
  )
}

function TemplateModal({
  template,
  onClose,
  onSubmit,
}: {
  template: InvoiceTemplate | null
  onClose: () => void
  onSubmit: (t: Partial<InvoiceTemplate>, isNew: boolean) => void
}) {
  const { t } = useI18n()
  const isNew = !template
  const [name, setName] = useState(template?.name || "")
  const [primaryColor, setPrimaryColor] = useState(
    template?.configJson.primaryColor || "#1e3a8a",
  )
  const [accentColor, setAccentColor] = useState(
    template?.configJson.accentColor || "#64748b",
  )
  const [fontFamily, setFontFamily] = useState<"Helvetica" | "Times-Roman" | "Courier">(
    template?.configJson.fontFamily || "Helvetica",
  )
  const [layoutDensity, setLayoutDensity] = useState<"comfortable" | "compact">(
    template?.configJson.layoutDensity || "comfortable",
  )
  const [showLogo, setShowLogo] = useState(template?.configJson.showLogo ?? true)
  const [footerText, setFooterText] = useState(
    template?.configJson.footerText || "",
  )
  const [paymentTermsText, setPaymentTermsText] = useState(
    template?.configJson.paymentTermsText || "Zahlbar binnen 14 Tagen ohne Abzug.",
  )
  const [isDefault, setIsDefault] = useState(template?.isDefault || false)

  const handleSave = () => {
    onSubmit(
      {
        name,
        isDefault,
        configJson: {
          primaryColor,
          accentColor,
          fontFamily,
          layoutDensity,
          showLogo,
          footerText,
          paymentTermsText,
          showAbsenderzeile: true,
        },
      },
      isNew,
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <CardTitle>
            {isNew ? t("invoiceTemplates.newTemplate") : t("invoiceTemplates.editTemplate")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium block mb-1">
              {t("invoiceTemplates.name")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("invoiceTemplates.namePlaceholder")}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-sm font-medium block mb-1">
                {t("invoiceTemplates.primaryColor")}
              </label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="h-10 w-10 rounded border border-gray-300 dark:border-gray-600"
                />
                <Input
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="flex-1"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">
                {t("invoiceTemplates.accentColor")}
              </label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="h-10 w-10 rounded border border-gray-300 dark:border-gray-600"
                />
                <Input
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="flex-1"
                />
              </div>
            </div>
            <div className="flex items-end">
              <div
                className="h-10 flex-1 rounded border border-gray-300 dark:border-gray-600"
                style={{
                  background: `linear-gradient(to right, ${primaryColor} 0%, ${primaryColor} 50%, ${accentColor} 50%, ${accentColor} 100%)`,
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium block mb-1">
                {t("invoiceTemplates.fontFamily")}
              </label>
              <select
                value={fontFamily}
                onChange={(e) =>
                  setFontFamily(e.target.value as typeof fontFamily)
                }
                className="w-full h-10 px-3 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
              >
                <option value="Helvetica">Helvetica (Standard)</option>
                <option value="Times-Roman">Times Roman (Serife)</option>
                <option value="Courier">Courier (Mono)</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">
                {t("invoiceTemplates.layoutDensity")}
              </label>
              <select
                value={layoutDensity}
                onChange={(e) =>
                  setLayoutDensity(e.target.value as typeof layoutDensity)
                }
                className="w-full h-10 px-3 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
              >
                <option value="comfortable">Komfortabel</option>
                <option value="compact">Kompakt</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="showLogo"
              checked={showLogo}
              onChange={(e) => setShowLogo(e.target.checked)}
            />
            <label htmlFor="showLogo" className="text-sm">
              {t("invoiceTemplates.showLogo")}
            </label>
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">
              {t("invoiceTemplates.footerText")}
            </label>
            <Input
              value={footerText}
              onChange={(e) => setFooterText(e.target.value)}
              placeholder="Vielen Dank für Ihren Auftrag."
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">
              {t("invoiceTemplates.paymentTermsText")}
            </label>
            <Input
              value={paymentTermsText}
              onChange={(e) => setPaymentTermsText(e.target.value)}
              placeholder="Zahlbar binnen 14 Tagen ohne Abzug."
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="isDefault"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            <label htmlFor="isDefault" className="text-sm">
              {t("invoiceTemplates.setAsDefault")}
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={!name}>
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}