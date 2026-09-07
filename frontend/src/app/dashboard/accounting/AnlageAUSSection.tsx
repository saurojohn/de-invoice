"use client"

// Tier 110: Anlage AUS (Ausländische Einkünfte,
// § 34d EStG). The 9th Anlage form — the
// international dimension.
//
// v1 covers the most common scenarios:
//   (a) Foreign dividends (Wertpapiere aus dem
//       Ausland) — with § 8b KStG for KapG
//   (b) Foreign interest (Zinsen)
//   (c) Foreign rental income
//   (d) Foreign employment / business income
//
// Per entry: country + countryName + hasDba
// (DBA-Freistellung or Anrechnung) + incomeType
// + grossAmount (EUR) + foreignTaxPaid (EUR) +
// description.
//
// The service computes:
//   - Per-country aggregation
//   - Progressionsvorbehalt (DBA-exempt income)
//   - Taxable portion (Anrechnung + § 8b KStG)
//   - Anrechnungsbetrag (foreign tax credit)
//   - § 8b KStG Pauschale (only for KapG)

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPut, ApiError } from "@/lib/api"

type AusIncomeType =
  | "dividend"
  | "interest"
  | "rental"
  | "employment"
  | "business"
  | "selfEmployment"
  | "agriculture"
  | "other"

interface AnlageAUSLine {
  kennziffer: string
  label: string
  amount: number
  source?: "computed" | "placeholder"
  note?: string
}

interface PerCountryRow {
  country: string
  countryName: string
  hasDba: boolean
  count: number
  grossTotal: number
  foreignTaxTotal: number
  taxablePortion: number
  exemptPortion: number
}

interface AnlageAUSResult {
  year: number
  companyId: string
  rechtsform: string
  isKapg: boolean
  entries: Array<{
    country: string
    countryName: string
    hasDba: boolean
    incomeType: AusIncomeType
    grossAmount: number
    foreignTaxPaid: number
    description: string
  }>
  perCountry: PerCountryRow[]
  lines: AnlageAUSLine[]
  totals: {
    grossTotal: number
    foreignTaxTotal: number
    progressionsvorbehalt: number
    taxable: number
    paragraph8b: number
    anrechnungsbetrag: number
  }
  counts: {
    hasEntries: boolean
    hasDbaEntries: boolean
    hasNonDbaEntries: boolean
    countryCount: number
  }
  generatedAt: string
  disclaimer: string
}

interface EntryRow {
  rowId: string
  country: string
  countryName: string
  hasDba: boolean
  incomeType: AusIncomeType
  grossAmount: string
  foreignTaxPaid: string
  description: string
}

function emptyRow(): EntryRow {
  return {
    rowId: `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    country: "",
    countryName: "",
    hasDba: true,
    incomeType: "dividend",
    grossAmount: "",
    foreignTaxPaid: "",
    description: "",
  }
}

function rowsFromEntries(entries: AnlageAUSResult["entries"]): EntryRow[] {
  return entries.map((e) => ({
    rowId: `row-${e.country || ""}-${e.description || ""}-${Math.random().toString(36).slice(2, 8)}`,
    country: e.country,
    countryName: e.countryName,
    hasDba: e.hasDba,
    incomeType: e.incomeType,
    grossAmount: String(e.grossAmount || ""),
    foreignTaxPaid: String(e.foreignTaxPaid || ""),
    description: e.description,
  }))
}

export function AnlageAUSSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<AnlageAUSResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<EntryRow[]>([])
  const [saving, setSaving] = useState(false)
  const [pdfUrl, setPdfUrl] = useState<string>("#")

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<AnlageAUSResult>(
        `/api/v1/accounting/anlage-aus?${params}`,
      )
      setData(result)
      setRows(
        result.entries.length > 0 ? rowsFromEntries(result.entries) : [],
      )
    } catch (e: any) {
      const msg =
        e instanceof ApiError ? e.message : tRef.current("anlageAus.loadError")
      toastRef.current.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(year)
  }, [year, load])

  useEffect(() => {
    if (typeof window === "undefined") return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setPdfUrl("#")
      return
    }
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    setPdfUrl(
      `${apiBase}/api/v1/accounting/anlage-aus.pdf?companyId=${companyId}&year=${year}`,
    )
  }, [year])

  const updateRow = (rowId: string, patch: Partial<EntryRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    )
  }

  const addRow = () => {
    setRows((prev) => [...prev, emptyRow()])
  }

  const removeRow = (rowId: string) => {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId))
  }

  const save = async () => {
    setSaving(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      if (!companyId) return
      const entries = rows
        .filter(
          (r) =>
            r.country || r.countryName || r.description ||
            r.grossAmount || r.foreignTaxPaid,
        )
        .map((r) => ({
          country: r.country,
          countryName: r.countryName,
          hasDba: r.hasDba,
          incomeType: r.incomeType,
          grossAmount: Number(r.grossAmount) || 0,
          foreignTaxPaid: Number(r.foreignTaxPaid) || 0,
          description: r.description,
        }))
      await apiPut(
        `/api/v1/accounting/anlage-aus/settings?companyId=${companyId}`,
        {
          year,
          entries,
        },
      )
      toastRef.current.success(tRef.current("anlageAus.savedOk"))
      await load(year)
    } catch (e: any) {
      const msg =
        e instanceof ApiError ? e.message : tRef.current("anlageAus.saveError")
      toastRef.current.error(msg)
    } finally {
      setSaving(false)
    }
  }

  const fmtEur = (n: number) =>
    new Intl.NumberFormat("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n || 0)

  return (
    <Card data-testid="anlage-aus-section">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t("anlageAus.title")}</CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor="anlage-aus-year" className="text-sm">
              {t("anlageAus.year")}
            </Label>
            <Input
              id="anlage-aus-year"
              type="number"
              min={2000}
              max={2100}
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="w-24"
              data-testid="anlage-aus-year-input"
            />
            <a
              href={pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="anlage-aus-pdf-link"
            >
              <Button variant="outline" size="sm" type="button">
                {t("anlageAus.downloadPdf")}
              </Button>
            </a>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
          {t("anlageAus.subtitle")}
        </p>

        {data?.isKapg && (
          <div
            className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded text-xs text-blue-800 dark:text-blue-200"
            data-testid="anlage-aus-kapg-hint"
          >
            ℹ {t("anlageAus.isKapg")} (Rechtsform: {data.rechtsform})
          </div>
        )}

        {loading && !data ? (
          <p className="text-sm text-gray-500">…</p>
        ) : (
          <>
            {/* Entries editor */}
            <div data-testid="anlage-aus-entries-editor">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-sm">
                  {t("anlageAus.entries")}
                </h3>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addRow}
                  data-testid="anlage-aus-add-row"
                >
                  + {t("anlageAus.addEntry")}
                </Button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                {t("anlageAus.entriesHint")}
              </p>
              {rows.length === 0 ? (
                <p
                  className="text-xs text-amber-700 dark:text-amber-400"
                  data-testid="anlage-aus-empty-entries"
                >
                  {t("anlageAus.emptyEntries")}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left border-b dark:border-gray-700">
                        <th className="py-1 pr-2 w-16">{t("anlageAus.country")}</th>
                        <th className="py-1 pr-2">{t("anlageAus.countryName")}</th>
                        <th className="py-1 pr-2">{t("anlageAus.incomeType")}</th>
                        <th className="py-1 pr-2">{t("anlageAus.hasDba")}</th>
                        <th className="py-1 pr-2 text-right">{t("anlageAus.grossAmount")}</th>
                        <th className="py-1 pr-2 text-right">{t("anlageAus.foreignTaxPaid")}</th>
                        <th className="py-1 pr-2">{t("anlageAus.description")}</th>
                        <th className="py-1 pr-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr
                          key={r.rowId}
                          className="border-b dark:border-gray-700"
                          data-testid={`anlage-aus-row-${r.rowId}`}
                        >
                          <td className="py-1 pr-2">
                            <Input
                              type="text"
                              maxLength={2}
                              value={r.country}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  country: e.target.value.toUpperCase(),
                                })
                              }
                              placeholder="US"
                              className="w-16"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Input
                              type="text"
                              value={r.countryName}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  countryName: e.target.value,
                                })
                              }
                              placeholder="USA"
                              className="w-24"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <select
                              value={r.incomeType}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  incomeType: e.target.value as AusIncomeType,
                                })
                              }
                              className="border rounded px-1 py-0.5 bg-white dark:bg-gray-800"
                            >
                              <option value="dividend">{t("anlageAus.dividend")}</option>
                              <option value="interest">{t("anlageAus.interest")}</option>
                              <option value="rental">{t("anlageAus.rental")}</option>
                              <option value="employment">{t("anlageAus.employment")}</option>
                              <option value="business">{t("anlageAus.business")}</option>
                              <option value="selfEmployment">{t("anlageAus.selfEmployment")}</option>
                              <option value="agriculture">{t("anlageAus.agriculture")}</option>
                              <option value="other">{t("anlageAus.other")}</option>
                            </select>
                          </td>
                          <td className="py-1 pr-2">
                            <input
                              type="checkbox"
                              className="w-4 h-4"
                              checked={r.hasDba}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  hasDba: e.target.checked,
                                })
                              }
                              data-testid={`anlage-aus-dba-${r.rowId}`}
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Input
                              type="number"
                              step="0.01"
                              value={r.grossAmount}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  grossAmount: e.target.value,
                                })
                              }
                              className="w-24 text-right"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Input
                              type="number"
                              step="0.01"
                              value={r.foreignTaxPaid}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  foreignTaxPaid: e.target.value,
                                })
                              }
                              className="w-24 text-right"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Input
                              type="text"
                              value={r.description}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  description: e.target.value,
                                })
                              }
                              placeholder="AAPL 100 shares"
                              className="w-32"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => removeRow(r.rowId)}
                              data-testid={`anlage-aus-remove-${r.rowId}`}
                            >
                              {t("anlageAus.removeEntry")}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <Button
                onClick={save}
                disabled={saving}
                data-testid="anlage-aus-save"
              >
                {saving ? "…" : t("anlageAus.save")}
              </Button>
            </div>

            {/* Per-country breakdown */}
            {data && data.perCountry.length > 0 && (
              <div
                className="overflow-x-auto"
                data-testid="anlage-aus-percountry-table"
              >
                <h3 className="font-semibold text-sm mb-2">
                  {t("anlageAus.entries")} ({data.counts.countryCount} {t("anlageAus.countryCount")})
                </h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left border-b dark:border-gray-700">
                      <th className="py-1 pr-2">Land</th>
                      <th className="py-1 pr-2">DBA</th>
                      <th className="py-1 pr-2 text-right">Brutto (€)</th>
                      <th className="py-1 pr-2 text-right">Steuerpflichtig (€)</th>
                      <th className="py-1 pr-2 text-right">Steuerfrei (€)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perCountry.map((c) => (
                      <tr
                        key={c.country}
                        className="border-b dark:border-gray-700"
                        data-testid={`anlage-aus-percountry-${c.country}`}
                      >
                        <td className="py-1 pr-2">
                          {c.countryName} ({c.country})
                        </td>
                        <td className="py-1 pr-2">
                          {c.hasDba ? t("anlageAus.hasDbaYes") : t("anlageAus.hasDbaNo")}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono">
                          {fmtEur(c.grossTotal)}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono">
                          {fmtEur(c.taxablePortion)}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono">
                          {fmtEur(c.exemptPortion)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* BMF Vordruck table */}
            {data && (
              <div
                className="overflow-x-auto"
                data-testid="anlage-aus-vordruck-table"
              >
                <h3 className="font-semibold text-sm mb-2">
                  {t("anlageAus.vordruck")}
                </h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left border-b dark:border-gray-700">
                      <th className="py-1 pr-2 w-10">Kz</th>
                      <th className="py-1 pr-2">Bezeichnung</th>
                      <th className="py-1 pr-2 text-right w-28">Betrag (€)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l) => (
                      <tr
                        key={l.kennziffer}
                        className="border-b dark:border-gray-700"
                        data-testid={`anlage-aus-${l.kennziffer}`}
                      >
                        <td className="py-1 pr-2 font-mono">{l.kennziffer}</td>
                        <td className="py-1 pr-2">
                          {l.label}
                          {l.source === "placeholder" && (
                            <span className="ml-2 text-amber-600 dark:text-amber-400" title={l.note}>
                              ⚠
                            </span>
                          )}
                        </td>
                        <td className="py-1 pr-2 text-right font-mono">
                          {fmtEur(l.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Summary block */}
            {data && (
              <div
                className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700"
                data-testid="anlage-aus-summary"
              >
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("anlageAus.totals")}
                  </div>
                  <div
                    className="text-xl font-bold mt-1"
                    data-testid="anlage-aus-summary-gross"
                  >
                    {fmtEur(data.totals.grossTotal)} €
                  </div>
                  <div className="text-xs text-gray-500">Σ Brutto</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("anlageAus.progressionsvorbehalt")}
                  </div>
                  <div
                    className="text-xl font-bold mt-1"
                    data-testid="anlage-aus-summary-progression"
                  >
                    {fmtEur(data.totals.progressionsvorbehalt)} €
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("anlageAus.taxableInland")}
                  </div>
                  <div
                    className="text-xl font-bold mt-1"
                    data-testid="anlage-aus-summary-taxable"
                  >
                    {fmtEur(data.totals.taxable)} €
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("anlageAus.anrechnungsbetrag")}
                  </div>
                  <div
                    className="text-xl font-bold mt-1 text-emerald-700 dark:text-emerald-400"
                    data-testid="anlage-aus-summary-anrechnung"
                  >
                    {fmtEur(data.totals.anrechnungsbetrag)} €
                  </div>
                </div>
              </div>
            )}

            {/* Disclaimer */}
            {data && (
              <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                {data.disclaimer}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
