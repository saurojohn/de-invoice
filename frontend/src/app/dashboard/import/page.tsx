"use client"

import { Suspense } from "react"

/**
 * BulkImport — unified CSV import page for customers,
 * products, and expenses (Eingangsrechnungen).
 *
 * Flow:
 *   1. Pick an entity type (Customer / Product / Expense)
 *   2. Download the matching CSV template OR drop in
 *      a pre-existing CSV file
 *   3. Preview the parsed rows in a table — server-
 *      side validation hasn't run yet, but blank
 *      required fields are highlighted client-side
 *   4. Click "Importieren" — POSTs the rows to the
 *      backend's /<entity>/import endpoint, which
 *      does the authoritative validation + creation
 *   5. Result panel shows: imported / skipped /
 *      per-row errors. The user can fix and re-upload
 *      the failed rows.
 *
 * The page is intentionally single-page (no router
 * push between steps) — staying in one place lets
 * the user correct errors and re-submit without
 * losing the rest of the work.
 */

import { useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiFetch, apiPost, ApiError } from "@/lib/api"
import { parseCsv } from "@/lib/csv"

type EntityType = "customer" | "product" | "expense"

function entityFromParam(s: string | null | undefined): EntityType {
  if (s === "product" || s === "expense" || s === "customer") return s
  return "customer"
}

interface ImportResult {
  total: number
  imported: number
  skipped: number
  errors: Array<{ row: number; error: string; name?: string; description?: string }>
}

// Per-entity config — required-field names + display
// columns for the preview table. Kept in code (not i18n)
// because the column headers must match what the backend
// expects verbatim — translating "name" to "Name" would
// break the import.
const ENTITIES: Record<EntityType, {
  label: string
  endpoint: string
  template: string
  required: string[]
  previewCols: string[]
  extraPreview: (row: Record<string, string>) => string
}> = {
  customer: {
    label: "Kunden",
    endpoint: "/api/v1/customers/import",
    template: "/api/v1/customers/import/template.csv",
    required: ["name"],
    previewCols: ["name", "vatId", "type", "city", "email", "paymentTerms"],
    extraPreview: () => "",
  },
  product: {
    label: "Produkte",
    endpoint: "/api/v1/products/import",
    template: "/api/v1/products/import/template.csv",
    required: ["name", "basePrice"],
    previewCols: ["name", "sku", "basePrice", "vatRate", "unit"],
    extraPreview: () => "",
  },
  expense: {
    label: "Eingangsrechnungen",
    endpoint: "/api/v1/expenses/import",
    template: "/api/v1/expenses/import/template.csv",
    required: ["description", "invoiceDate", "netAmount"],
    previewCols: ["description", "invoiceDate", "supplierName", "netAmount", "vatRate", "invoiceNumber"],
    extraPreview: () => "",
  },
}

function BulkImportPageInner() {
  const router = useRouter()
  const { t } = useI18n()
  // Read the initial entity from ?entity=… so deep
  // links from the Customers / Products / Expenses
  // list pages land on the right picker automatically.
  // useSearchParams() is safe for both SSR and client
  // — it returns the same value on the server pass
  // and on hydration, so there's no mismatch warning.
  const searchParams = useSearchParams()
  const [entity, setEntity] = useState<EntityType>(
    () => entityFromParam(searchParams.get("entity"))
  )
  const [, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, string>[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Reset everything when the user switches entity
  // type — a customer CSV has different required
  // fields than an expense CSV, so the preview
  // would be misleading otherwise.
  const switchEntity = (e: EntityType) => {
    setEntity(e)
    setHeaders([])
    setRows([])
    setResult(null)
    setSubmitError(null)
    setParseError(null)
  }

  const handleFile = async (file: File) => {
    setParseError(null)
    setResult(null)
    setSubmitError(null)
    try {
      const text = await file.text()
      const parsed = parseCsv(text)
      if (parsed.headers.length === 0) {
        setParseError("Die Datei enthält keine Kopfzeile.")
        return
      }
      if (parsed.rows.length === 0) {
        setParseError("Die Datei enthält keine Datenzeilen.")
        return
      }
      setHeaders(parsed.headers)
      setRows(parsed.rows)
    } catch (e: any) {
      setParseError(`Fehler beim Lesen: ${e?.message || 'Unbekannter Fehler'}`)
    }
  }

  // Client-side validation — flag rows that are
  // missing required fields BEFORE the server-side
  // import. Saves a round-trip for the common case
  // (forgot the column). The server is still the
  // source of truth for the final validation result.
  const clientValidate = (): { ok: boolean; missing: string[] } => {
    const required = ENTITIES[entity].required
    const missing: string[] = []
    rows.forEach((row, idx) => {
      for (const k of required) {
        if (!row[k] || !row[k].trim()) {
          missing.push(`Zeile ${idx + 2}: "${k}" fehlt`)
        }
      }
    })
    return { ok: missing.length === 0, missing }
  }

  const submit = async () => {
    setSubmitting(true)
    setSubmitError(null)
    setResult(null)
    try {
      const companyId = localStorage.getItem("companyId")
      if (!companyId) {
        setSubmitError("Kein Unternehmen angemeldet.")
        return
      }
      const validation = clientValidate()
      if (!validation.ok) {
        setSubmitError(
          `${validation.missing.length} Zeile(n) unvollständig — bitte korrigieren und erneut hochladen.`,
        )
        return
      }
      const data = await apiPost<ImportResult>(
        `${ENTITIES[entity].endpoint}?companyId=${companyId}`,
        { rows },
      )
      setResult(data)
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : "Netzwerkfehler")
    } finally {
      setSubmitting(false)
    }
  }

  const downloadTemplate = async () => {
    const companyId = localStorage.getItem("companyId")
    // The template endpoint doesn't strictly need
    // companyId (it's static) but we pass it to keep
    // consistent with other endpoints.
    const url = `${ENTITIES[entity].template}?companyId=${companyId || ""}`
    try {
      // Tier 390: a relative fetch reached the Next server, not the backend
      // (measured: 404 there, 200 from the API). apiFetch prefixes API_BASE.
      const res = await apiFetch(url, { throwOnError: false })
      if (!res.ok) {
        setSubmitError(`Template-Download fehlgeschlagen: HTTP ${res.status}`)
        return
      }
      const text = await res.text()
      const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `${entity}-template.csv`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e: any) {
      setSubmitError(`Template-Download: ${e?.message}`)
    }
  }

  const reset = () => {
    setHeaders([])
    setRows([])
    setResult(null)
    setSubmitError(null)
    setParseError(null)
  }

  // Local helper — returns true if any row is missing
  // a required field (used to render the red border
  // and the disabled submit button).
  const hasValidationErrors = () => {
    const required = ENTITIES[entity].required
    return rows.some((row) => required.some((k) => !row[k] || !row[k].trim()))
  }

  // The page uses only German labels for entity types
  // and form fields (the column headers are part of
  // the CSV contract with the backend — translating
  // them would break the import). Other UI strings
  // (buttons, status messages) are routed through t().
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t("import.title") || "Bulk-Import"}
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              {t("import.subtitle") || "CSV-Import für Kunden, Produkte und Eingangsrechnungen"}
            </p>
          </div>
          <LanguageSwitcher />
        </div>

        {/* Step 1: entity picker */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>1. Datentyp wählen</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {(Object.keys(ENTITIES) as EntityType[]).map((e) => (
                <button
                  key={e}
                  onClick={() => switchEntity(e)}
                  className={`px-4 py-2 text-sm rounded border transition ${
                    entity === e
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                  }`}
                >
                  {ENTITIES[e].label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Step 2: template download + file drop */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>2. CSV-Vorlage & Datei hochladen</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col md:flex-row gap-4 items-start">
              <Button variant="outline" onClick={downloadTemplate}>
                📥 {t("import.downloadTemplate") || "Vorlage herunterladen"}
              </Button>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const file = e.dataTransfer.files[0]
                  if (file) handleFile(file)
                }}
                onClick={() => fileInputRef.current?.click()}
                className="flex-1 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center cursor-pointer hover:border-gray-400 dark:hover:border-gray-500"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleFile(file)
                  }}
                  className="hidden"
                />
                <div className="text-2xl mb-1">📄</div>
                <div className="text-sm text-gray-600 dark:text-gray-300">
                  {t("import.dropZone") || "CSV-Datei hier ablegen oder klicken"}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Max. 5.000 Zeilen pro Import
                </div>
              </div>
            </div>
            {parseError && (
              <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
                ⚠ {parseError}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 3: preview table */}
        {rows.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>
                3. Vorschau — {rows.length} {t("import.rows") || "Zeile(n)"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-gray-500 dark:text-gray-400">
                      <th className="py-2 pr-3 font-medium">#</th>
                      {ENTITIES[entity].previewCols.map((col) => (
                        <th key={col} className="py-2 pr-3 font-medium">
                          {col}
                          {ENTITIES[entity].required.includes(col) && (
                            <span className="text-red-500 ml-1">*</span>
                          )}
                        </th>
                      ))}
                      <th className="py-2 pr-3 font-medium">
                        {t("import.rowStatus") || "Status"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 50).map((row, idx) => {
                      const required = ENTITIES[entity].required
                      const missing = required.filter((k) => !row[k] || !row[k].trim())
                      return (
                        <tr key={idx} className="border-b hover:bg-gray-50 dark:hover:bg-gray-800">
                          <td className="py-2 pr-3 text-gray-400 dark:text-gray-500 font-mono">
                            {idx + 2}
                          </td>
                          {ENTITIES[entity].previewCols.map((col) => (
                            <td
                              key={col}
                              className={`py-2 pr-3 font-mono text-xs ${
                                ENTITIES[entity].required.includes(col) && (!row[col] || !row[col].trim())
                                  ? "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20"
                                  : "text-gray-700 dark:text-gray-300"
                              }`}
                            >
                              {row[col] || (
                                <span className="text-gray-300 dark:text-gray-600">—</span>
                              )}
                            </td>
                          ))}
                          <td className="py-2 pr-3">
                            {missing.length > 0 ? (
                              <span className="text-xs text-red-600 dark:text-red-400">
                                ⚠ {missing.join(", ")}
                              </span>
                            ) : (
                              <span className="text-xs text-emerald-600 dark:text-emerald-400">
                                ✓ OK
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {rows.length > 50 && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    + {rows.length - 50} weitere Zeile(n) — alle werden importiert.
                  </div>
                )}
              </div>
              <div className="mt-4 flex gap-2 justify-end">
                <Button variant="outline" onClick={reset}>
                  {t("common.reset") || "Zurücksetzen"}
                </Button>
                <Button
                  onClick={submit}
                  disabled={submitting || hasValidationErrors()}
                >
                  {submitting
                    ? (t("import.importing") || "Wird importiert...")
                    : `${rows.length} ${t("import.importButton") || "Zeilen importieren"}`}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 4: result panel */}
        {result && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>
                {t("import.result") || "Ergebnis"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded p-3">
                  <div className="text-xs text-emerald-700 dark:text-emerald-300 uppercase">
                    {t("import.imported") || "Importiert"}
                  </div>
                  <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-300 mt-1 font-mono">
                    {result.imported}
                  </div>
                </div>
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-3">
                  <div className="text-xs text-amber-700 dark:text-amber-300 uppercase">
                    {t("import.skipped") || "Übersprungen"}
                  </div>
                  <div className="text-2xl font-bold text-amber-700 dark:text-amber-300 mt-1 font-mono">
                    {result.skipped}
                  </div>
                </div>
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded p-3">
                  <div className="text-xs text-red-700 dark:text-red-300 uppercase">
                    {t("import.errors") || "Fehler"}
                  </div>
                  <div className="text-2xl font-bold text-red-700 dark:text-red-300 mt-1 font-mono">
                    {result.errors.length}
                  </div>
                </div>
              </div>
              {result.errors.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                    {t("import.errorRows") || "Fehlerhafte Zeilen"}
                  </h3>
                  <div className="border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-gray-800">
                        <tr className="text-left text-gray-500 dark:text-gray-400">
                          <th className="py-2 px-3 font-medium">Zeile</th>
                          <th className="py-2 px-3 font-medium">Datensatz</th>
                          <th className="py-2 px-3 font-medium">Fehler</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.errors.map((e, idx) => (
                          <tr key={idx} className="border-t border-gray-200 dark:border-gray-700">
                            <td className="py-2 px-3 font-mono text-gray-500 dark:text-gray-400">
                              {e.row}
                            </td>
                            <td className="py-2 px-3 text-gray-700 dark:text-gray-300">
                              {e.name || e.description || "—"}
                            </td>
                            <td className="py-2 px-3 text-red-700 dark:text-red-400">
                              {e.error}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="mt-4 flex justify-end gap-2">
                {result.imported > 0 && (
                  <Button variant="outline" onClick={() => router.push(`/dashboard/${entity}s`)}>
                    {t("import.viewList") || "Zur Liste"}
                  </Button>
                )}
                <Button onClick={reset}>
                  {t("import.newImport") || "Neuer Import"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {submitError && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300">
            ⚠ {submitError}
          </div>
        )}
      </div>
    </div>
  )
}

export default function BulkImportPage() {
  return (
    <Suspense fallback={null}>
      <BulkImportPageInner />
    </Suspense>
  )
}
