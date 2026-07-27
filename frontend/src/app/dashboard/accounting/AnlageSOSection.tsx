"use client"

// Tier 109: Anlage SO (Sonstige Einkünfte, § 22 EStG).
//
// The 8th Anlage form — the catch-all for Einkünfte
// that don't fit the other Anlagen. v1 focuses on:
//
//   (a) Private Veräußerungsgeschäfte (§ 23 EStG):
//       sales of Wertpapiere (1-Jahr Frist) +
//       Sonstige Wirtschaftsgüter (10-Jahre Frist).
//       For each transaction the user enters:
//       type + description + acquisitionDate +
//       acquisitionCost + saleDate + salePrice.
//       The service computes the gain + checks
//       Spekulationsfrist + applies 600 EUR
//       Freigrenze.
//
//   (b) Wiederkehrende Bezüge (§ 22 Nr. 1 EStG):
//       total amount + Werbungskosten. The
//       BMF-Pauschbetrag is 102 EUR (statutory
//       pensions) — the user can enter the actual
//       amount if higher.
//
// Layout:
//   - Year picker + PDF link
//   - Empty-state hint when no data
//   - Editor: Transactions table (add/remove rows)
//     + Wiederkehrende Bezüge inputs + Save button
//   - BMF Vordruck table: Kz 32/34/41/20/11/12
//   - Summary block: Σ Einkünfte

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPut, ApiError } from "@/lib/api"

interface AnlageSOLine {
  kennziffer: string
  label: string
  amount: number
  source?: "computed" | "placeholder"
  note?: string
}

interface AnlageSOResult {
  year: number
  companyId: string
  transactions: VgTransaction[]
  wiederkehrendeBezuege: number
  werbungskosten: number
  vg: {
    count: number
    countWertpapier: number
    countSonstige: number
    totalGain: number
    totalLoss: number
    taxableGain: number
    inSpekulationsfrist: number
  }
  freigrenze: number
  lines: AnlageSOLine[]
  totals: {
    vgTotal: number
    wiederkehrendeBezuegeTotal: number
    werbungskostenTotal: number
    einkuenfte: number
  }
  counts: {
    hasVg: boolean
    hasWiederkehrende: boolean
  }
  generatedAt: string
  disclaimer: string
}

interface VgTransaction {
  type: "wertpapier" | "sonstige"
  description: string
  acquisitionDate: string
  acquisitionCost: number
  saleDate: string
  salePrice: number
}

interface TransactionRow {
  // local row id for React key (server doesn't require id)
  rowId: string
  type: "wertpapier" | "sonstige"
  description: string
  acquisitionDate: string
  acquisitionCost: string // string for input
  saleDate: string
  salePrice: string
}

function emptyRow(): TransactionRow {
  return {
    rowId: `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "wertpapier",
    description: "",
    acquisitionDate: "",
    acquisitionCost: "",
    saleDate: "",
    salePrice: "",
  }
}

function rowsFromTransactions(txs: VgTransaction[]): TransactionRow[] {
  return txs.map((t) => ({
    rowId: `row-${t.acquisitionDate || ""}-${t.saleDate || ""}-${Math.random().toString(36).slice(2, 8)}`,
    type: t.type,
    description: t.description,
    acquisitionDate: t.acquisitionDate,
    acquisitionCost: String(t.acquisitionCost || ""),
    saleDate: t.saleDate,
    salePrice: String(t.salePrice || ""),
  }))
}

export function AnlageSOSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<AnlageSOResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<TransactionRow[]>([])
  const [wiederkehrendeBezuege, setWiederkehrendeBezuege] = useState<string>("")
  const [werbungskosten, setWerbungskosten] = useState<string>("")
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
      const result = await apiGet<AnlageSOResult>(
        `/api/v1/accounting/anlage-so?${params}`,
      )
      setData(result)
      setRows(
        result.transactions.length > 0
          ? rowsFromTransactions(result.transactions)
          : [],
      )
      setWiederkehrendeBezuege(String(result.wiederkehrendeBezuege || ""))
      setWerbungskosten(String(result.werbungskosten || ""))
    } catch (e: any) {
      const msg =
        e instanceof ApiError ? e.message : tRef.current("anlageSo.loadError")
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
      `${apiBase}/api/v1/accounting/anlage-so.pdf?companyId=${companyId}&year=${year}`,
    )
  }, [year])

  const updateRow = (rowId: string, patch: Partial<TransactionRow>) => {
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
      // Filter out fully-empty rows
      const transactions = rows
        .filter(
          (r) =>
            r.description || r.acquisitionDate || r.saleDate ||
            r.acquisitionCost || r.salePrice,
        )
        .map((r) => ({
          type: r.type,
          description: r.description,
          acquisitionDate: r.acquisitionDate,
          acquisitionCost: Number(r.acquisitionCost) || 0,
          saleDate: r.saleDate,
          salePrice: Number(r.salePrice) || 0,
        }))
      await apiPut(
        `/api/v1/accounting/anlage-so/settings?companyId=${companyId}`,
        {
          year,
          transactions,
          wiederkehrendeBezuege: Number(wiederkehrendeBezuege) || 0,
          werbungskosten: Number(werbungskosten) || 0,
        },
      )
      toastRef.current.success(tRef.current("anlageSo.savedOk"))
      await load(year)
    } catch (e: any) {
      const msg =
        e instanceof ApiError ? e.message : tRef.current("anlageSo.saveError")
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

  const fmtDateDE = (s: string) => s || "—"

  return (
    <Card data-testid="anlage-so-section">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t("anlageSo.title")}</CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor="anlage-so-year" className="text-sm">
              {t("anlageSo.year")}
            </Label>
            <Input
              id="anlage-so-year"
              type="number"
              min={2000}
              max={2100}
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="w-24"
              data-testid="anlage-so-year-input"
            />
            <a
              href={pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="anlage-so-pdf-link"
            >
              <Button variant="outline" size="sm" type="button">
                {t("anlageSo.downloadPdf")}
              </Button>
            </a>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
          {t("anlageSo.subtitle")}
        </p>

        {loading && !data ? (
          <p className="text-sm text-gray-500">…</p>
        ) : (
          <>
            {/* Transactions editor */}
            <div data-testid="anlage-so-transactions-editor">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-sm">
                  {t("anlageSo.transactions")}
                </h3>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addRow}
                  data-testid="anlage-so-add-row"
                >
                  + {t("anlageSo.addTransaction")}
                </Button>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                {t("anlageSo.transactionsHint")}
              </p>
              {rows.length === 0 ? (
                <p
                  className="text-xs text-amber-700 dark:text-amber-400"
                  data-testid="anlage-so-empty-transactions"
                >
                  {t("anlageSo.emptyTransactions")}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left border-b dark:border-gray-700">
                        <th className="py-1 pr-2">{t("anlageSo.type")}</th>
                        <th className="py-1 pr-2">{t("anlageSo.description")}</th>
                        <th className="py-1 pr-2">{t("anlageSo.acquisitionDate")}</th>
                        <th className="py-1 pr-2">{t("anlageSo.acquisitionCost")}</th>
                        <th className="py-1 pr-2">{t("anlageSo.saleDate")}</th>
                        <th className="py-1 pr-2">{t("anlageSo.salePrice")}</th>
                        <th className="py-1 pr-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr
                          key={r.rowId}
                          className="border-b dark:border-gray-700"
                          data-testid={`anlage-so-row-${r.rowId}`}
                        >
                          <td className="py-1 pr-2">
                            <select
                              value={r.type}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  type: e.target.value as "wertpapier" | "sonstige",
                                })
                              }
                              className="border rounded px-1 py-0.5 bg-white dark:bg-gray-800"
                            >
                              <option value="wertpapier">
                                {t("anlageSo.wertpapier")}
                              </option>
                              <option value="sonstige">
                                {t("anlageSo.sonstige")}
                              </option>
                            </select>
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
                              placeholder="BTC 0.1"
                              className="w-32"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Input
                              type="date"
                              value={r.acquisitionDate}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  acquisitionDate: e.target.value,
                                })
                              }
                              className="w-36"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Input
                              type="number"
                              step="0.01"
                              value={r.acquisitionCost}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  acquisitionCost: e.target.value,
                                })
                              }
                              className="w-24 text-right"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Input
                              type="date"
                              value={r.saleDate}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  saleDate: e.target.value,
                                })
                              }
                              className="w-36"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Input
                              type="number"
                              step="0.01"
                              value={r.salePrice}
                              onChange={(e) =>
                                updateRow(r.rowId, {
                                  salePrice: e.target.value,
                                })
                              }
                              className="w-24 text-right"
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => removeRow(r.rowId)}
                              data-testid={`anlage-so-remove-${r.rowId}`}
                            >
                              {t("anlageSo.removeTransaction")}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Wiederkehrende Bezüge editor */}
            <div
              className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 border rounded dark:border-gray-700"
              data-testid="anlage-so-wiederkehrende-editor"
            >
              <div>
                <Label htmlFor="anlage-so-bezuege">
                  {t("anlageSo.wiederkehrendeBezuege")}
                </Label>
                <Input
                  id="anlage-so-bezuege"
                  type="number"
                  step="0.01"
                  value={wiederkehrendeBezuege}
                  onChange={(e) => setWiederkehrendeBezuege(e.target.value)}
                  data-testid="anlage-so-bezuege-input"
                />
              </div>
              <div>
                <Label htmlFor="anlage-so-werbungskosten">
                  {t("anlageSo.werbungskosten")}
                </Label>
                <Input
                  id="anlage-so-werbungskosten"
                  type="number"
                  step="0.01"
                  value={werbungskosten}
                  onChange={(e) => setWerbungskosten(e.target.value)}
                  data-testid="anlage-so-werbungskosten-input"
                />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 md:col-span-2">
                {t("anlageSo.wiederkehrendeHint")}
              </p>
            </div>

            <div>
              <Button
                onClick={save}
                disabled={saving}
                data-testid="anlage-so-save"
              >
                {saving ? "…" : t("anlageSo.save")}
              </Button>
            </div>

            {/* BMF Vordruck table */}
            {data && (
              <div
                className="overflow-x-auto"
                data-testid="anlage-so-vordruck-table"
              >
                <h3 className="font-semibold text-sm mb-2">
                  {t("anlageSo.vordruck")}
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
                        data-testid={`anlage-so-${l.kennziffer}`}
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
                {data.lines.find((l) => l.note) && (
                  <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 space-y-1">
                    {data.lines
                      .filter((l) => l.note)
                      .map((l) => (
                        <div key={l.kennziffer}>
                          <strong>Kz {l.kennziffer}:</strong> {l.note}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            {/* Summary block */}
            {data && (
              <div
                className="grid grid-cols-1 md:grid-cols-4 gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700"
                data-testid="anlage-so-summary"
              >
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("anlageSo.transactionCount")}
                  </div>
                  <div
                    className="text-xl font-bold mt-1"
                    data-testid="anlage-so-summary-count"
                  >
                    {data.vg.count}
                  </div>
                  <div className="text-xs text-gray-500">
                    {data.vg.inSpekulationsfrist} {t("anlageSo.inFrist")}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    {t("anlageSo.freigrenze")}
                  </div>
                  <div
                    className="text-xl font-bold mt-1"
                    data-testid="anlage-so-summary-freigrenze"
                  >
                    {fmtEur(data.freigrenze)} €
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    Σ {t("anlageSo.transactions").split(" (")[0]}
                  </div>
                  <div
                    className="text-xl font-bold mt-1"
                    data-testid="anlage-so-summary-vg"
                  >
                    {fmtEur(data.totals.vgTotal)} €
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                    Σ Einkünfte
                  </div>
                  <div
                    className="text-xl font-bold mt-1 text-emerald-700 dark:text-emerald-400"
                    data-testid="anlage-so-summary-einkuenfte"
                  >
                    {fmtEur(data.totals.einkuenfte)} €
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
