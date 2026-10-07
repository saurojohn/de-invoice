"use client"

/**
 * Tier 573 — an incoming e-invoice (XRechnung, ZUGFeRD / Factur-X).
 *
 * Two uses of the same view:
 *   - import: a file was picked. The server reads it and says what is in it and
 *     what an import would create; the person looks, confirms what needs
 *     confirming, and imports.
 *   - view: the e-invoice kept with an expense, shown readable — the XML is the
 *     invoice, and a person has to be able to read it.
 */

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiFetch, apiGet } from "@/lib/api"
import { todayIso } from "@/lib/today"

interface Party {
  name: string | null
  vatId: string | null
  taxNumber: string | null
  street: string | null
  postalCode: string | null
  city: string | null
  country: string | null
  email: string | null
}

export interface EInvoice {
  syntax: string
  profile: string
  typeCode: string | null
  creditNote: boolean
  number: string | null
  issueDate: string | null
  dueDate: string | null
  deliveryDate: string | null
  periodStart: string | null
  periodEnd: string | null
  currency: string | null
  orderReference: string | null
  precedingInvoice: string | null
  notes: string[]
  seller: Party
  buyer: Party
  payment: { iban: string | null; bic: string | null; remittance: string | null; terms: string | null }
  skonto?: { days: number; percent: number; amount: number | null }[]
  totals: { net: number | null; tax: number | null; gross: number | null; prepaid: number | null; payable: number | null }
  taxGroups: { category: string; rate: number; taxableAmount: number; taxAmount: number; exemptionReason: string | null }[]
  lines: {
    id: string | null
    name: string | null
    description: string | null
    quantity: number | null
    unit: string | null
    unitPrice: number | null
    netAmount: number | null
    taxRate: number | null
  }[]
}

interface Preview {
  eInvoice: true
  source: "xml" | "pdf"
  embeddedFile: string | null
  invoice: EInvoice
  supplier: { id: string; name: string; matchedBy: "chosen" | "vatId" | "name" | null } | null
  supplierWillBeCreated: boolean
  ibanDiffers: boolean
  buyerMatches: boolean | null
  duplicate: { expenseId: string; reason: "file" | "number"; message: string } | null
  expenses: {
    description: string
    netAmount: number
    vatAmount: number
    grossAmount: number
    vatRate: number
    taxCategory: string
    // Tier 581: one expense, a line per VAT rate
    taxLines?: { vatRate: number; netAmount: number; vatAmount: number }[]
  }[]
  blocking: string[]
  warnings: string[]
  importable: boolean
}

type Mode = { kind: "import"; file: File } | { kind: "view"; expenseId: string }

// UN/ECE Recommendation 20 — the units an invoice usually names
const UNITS: Record<string, string> = {
  C62: "Stk", H87: "Stk", XPP: "Stk", HUR: "Std", DAY: "Tag", MON: "Monat", ANN: "Jahr", KGM: "kg", GRM: "g", TNE: "t",
  MTR: "m", KMT: "km", MTK: "m²", MTQ: "m³", LTR: "l", KWH: "kWh", MIN: "Min", LS: "pauschal", SET: "Set", XBX: "Karton",
}

export function EInvoiceDialog({ mode, onClose, onImported }: { mode: Mode; onClose: () => void; onImported?: () => void }) {
  const { t, locale } = useI18n()
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading")
  const [error, setError] = useState("")
  const [preview, setPreview] = useState<Preview | null>(null)
  const [viewed, setViewed] = useState<{ invoice: EInvoice; source: string; embeddedFile: string | null; originalName: string } | null>(null)
  const [confirmDuplicate, setConfirmDuplicate] = useState(false)
  const [confirmRecipient, setConfirmRecipient] = useState(false)
  const [exchangeRate, setExchangeRate] = useState("")
  const [paid, setPaid] = useState(false)
  const [paidAt, setPaidAt] = useState(todayIso())
  // Tier 578: the official validator's verdict on the received file, on request
  const [check, setCheck] = useState<
    | null
    | "running"
    | { available: boolean; valid?: boolean; errors?: { rule?: string; message: string }[]; failed?: string }
  >(null)

  const file = mode.kind === "import" ? mode.file : null
  const expenseId = mode.kind === "view" ? mode.expenseId : null

  const form = useCallback(
    (rate: string) => {
      const fd = new FormData()
      if (file) fd.append("file", file)
      if (rate.trim()) fd.append("exchangeRate", rate.trim())
      return fd
    },
    [file],
  )

  const loadPreview = useCallback(
    async (rate: string) => {
      const companyId = localStorage.getItem("companyId") || ""
      setState("loading")
      try {
        const res = await apiFetch(`/api/v1/expenses/e-invoice/preview?companyId=${companyId}`, { method: "POST", body: form(rate) })
        const data = await res.json()
        if (!data.eInvoice) {
          setError(t("eInvoice.notAnEInvoice"))
          setState("error")
          return
        }
        setPreview(data)
        setState("ready")
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setState("error")
      }
    },
    [form, t],
  )

  useEffect(() => {
    if (file) {
      loadPreview("")
      return
    }
    if (!expenseId) return
    const companyId = localStorage.getItem("companyId") || ""
    apiGet(`/api/v1/expenses/${expenseId}/e-invoice?companyId=${companyId}`)
      .then((data) => {
        if (!data.eInvoice) {
          setError(t("eInvoice.noneStored"))
          setState("error")
          return
        }
        setViewed(data)
        setState("ready")
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e))
        setState("error")
      })
    // the file / expense is fixed for the life of the dialog
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doImport = async () => {
    if (!preview) return
    const companyId = localStorage.getItem("companyId") || ""
    setState("saving")
    try {
      const fd = form(exchangeRate)
      if (confirmDuplicate) fd.append("confirmDuplicate", "true")
      if (confirmRecipient) fd.append("confirmRecipient", "true")
      if (paid && paidAt) fd.append("paidAt", paidAt)
      await apiFetch(`/api/v1/expenses/e-invoice/import?companyId=${companyId}`, { method: "POST", body: fd })
      onImported?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState("error")
    }
  }

  const runCheck = async () => {
    if (!file) return
    const companyId = localStorage.getItem("companyId") || ""
    setCheck("running")
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await apiFetch(`/api/v1/expenses/e-invoice/validate?companyId=${companyId}`, { method: "POST", body: fd })
      setCheck(await res.json())
    } catch (e) {
      setCheck({ available: true, failed: e instanceof Error ? e.message : String(e) })
    }
  }

  const inv = preview?.invoice ?? viewed?.invoice ?? null
  const intl = locale === "de" ? "de-DE" : locale === "zh" ? "zh-CN" : "en-US"
  const money = (n: number | null | undefined, currency?: string | null) =>
    n == null ? "—" : new Intl.NumberFormat(intl, { style: "currency", currency: currency || inv?.currency || "EUR" }).format(n)
  const num = (n: number | null) => (n == null ? "" : new Intl.NumberFormat(intl, { maximumFractionDigits: 4 }).format(n))
  const day = (s: string | null) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString(intl) : "—")
  const foreign = !!inv?.currency && inv.currency !== "EUR"
  const needsDuplicate = !!preview?.duplicate
  const needsRecipient = preview?.buyerMatches === false
  const canImport =
    !!preview && preview.importable && (!needsDuplicate || confirmDuplicate) && (!needsRecipient || confirmRecipient) && state === "ready"

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" data-testid="einvoice-dialog">
      <Card className="w-full max-w-4xl max-h-[92vh] overflow-y-auto">
        <CardHeader>
          <CardTitle>
            {mode.kind === "import" ? t("eInvoice.importTitle") : t("eInvoice.viewTitle")}
            {inv?.number ? ` — ${inv.number}` : ""}
          </CardTitle>
          {inv && (
            <div className="text-sm text-gray-500 dark:text-gray-400 mt-1" data-testid="einvoice-profile">
              {inv.profile} · {inv.syntax === "cii" ? "CII" : "UBL"}
              {(preview?.source ?? viewed?.source) === "pdf" ? ` · ${t("eInvoice.embeddedIn")} ${preview?.embeddedFile ?? viewed?.embeddedFile ?? "PDF"}` : ""}
              {inv.creditNote ? ` · ${t("eInvoice.creditNote")}` : ""}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {state === "loading" && <div className="py-8 text-center text-gray-500" data-testid="einvoice-loading">{t("eInvoice.reading")}</div>}
          {state === "saving" && <div className="py-8 text-center text-gray-500">{t("eInvoice.importing")}</div>}
          {state === "error" && (
            <div data-testid="einvoice-error">
              <div className="p-3 rounded border border-red-300 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200 text-sm whitespace-pre-wrap">{error}</div>
              <div className="mt-4 flex justify-end gap-2">
                {preview && (
                  <Button variant="outline" onClick={() => setState("ready")}>
                    {t("common.back")}
                  </Button>
                )}
                <Button variant="outline" onClick={onClose}>
                  {t("common.close")}
                </Button>
              </div>
            </div>
          )}
          {state === "ready" && inv && (
            <div className="space-y-4 text-sm">
              {preview?.blocking.map((m) => (
                <div key={m} className="p-3 rounded border border-red-300 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200" data-testid="einvoice-blocking">
                  {m}
                </div>
              ))}
              {preview?.warnings.map((m) => (
                <div key={m} className="p-3 rounded border border-yellow-300 bg-yellow-50 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-100" data-testid="einvoice-warning">
                  {m}
                </div>
              ))}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border rounded p-3">
                  <div className="text-xs uppercase text-gray-500 dark:text-gray-400">{t("eInvoice.seller")}</div>
                  <div className="font-semibold" data-testid="einvoice-seller">{inv.seller.name || "—"}</div>
                  <div>{[inv.seller.street, [inv.seller.postalCode, inv.seller.city].filter(Boolean).join(" "), inv.seller.country].filter(Boolean).join(", ")}</div>
                  {inv.seller.vatId && <div className="font-mono text-xs mt-1">USt-IdNr. {inv.seller.vatId}</div>}
                  {inv.seller.taxNumber && <div className="font-mono text-xs">St.-Nr. {inv.seller.taxNumber}</div>}
                  {inv.seller.email && <div className="text-xs">{inv.seller.email}</div>}
                  {preview && (
                    <div className="mt-2 text-xs" data-testid="einvoice-supplier-match">
                      {preview.supplier
                        ? `✓ ${t(preview.supplier.matchedBy === "vatId" ? "eInvoice.supplierByVatId" : "eInvoice.supplierByName")}: ${preview.supplier.name}`
                        : `＋ ${t("eInvoice.supplierNew")}`}
                    </div>
                  )}
                </div>
                <div className="border rounded p-3">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    <div className="text-gray-500 dark:text-gray-400">{t("eInvoice.number")}</div>
                    <div className="font-mono">{inv.number || "—"}</div>
                    <div className="text-gray-500 dark:text-gray-400">{t("eInvoice.date")}</div>
                    <div>{day(inv.issueDate)}</div>
                    <div className="text-gray-500 dark:text-gray-400">{t("eInvoice.due")}</div>
                    <div>{day(inv.dueDate)}</div>
                    {(inv.periodStart || inv.periodEnd || inv.deliveryDate) && (
                      <>
                        <div className="text-gray-500 dark:text-gray-400">{t("eInvoice.delivery")}</div>
                        <div>{inv.periodStart || inv.periodEnd ? `${day(inv.periodStart)} – ${day(inv.periodEnd)}` : day(inv.deliveryDate)}</div>
                      </>
                    )}
                    <div className="text-gray-500 dark:text-gray-400">{t("eInvoice.recipient")}</div>
                    <div>{inv.buyer.name || "—"}</div>
                    {inv.payment.iban && (
                      <>
                        <div className="text-gray-500 dark:text-gray-400">IBAN</div>
                        <div className={`font-mono text-xs break-all ${preview?.ibanDiffers ? "text-red-700 dark:text-red-300 font-bold" : ""}`}>{inv.payment.iban}</div>
                      </>
                    )}
                    {inv.payment.terms && (
                      <>
                        <div className="text-gray-500 dark:text-gray-400">{t("eInvoice.terms")}</div>
                        <div>{inv.payment.terms}</div>
                      </>
                    )}
                    {(inv.skonto ?? []).map((sk) => (
                      <div key={`${sk.days}-${sk.percent}`} className="contents" data-testid="einvoice-skonto">
                        <div className="text-gray-500 dark:text-gray-400">Skonto</div>
                        <div>
                          {t("eInvoice.skontoLine").replace("{percent}", num(sk.percent)).replace("{days}", String(sk.days))}
                          {sk.amount != null ? ` (${money(sk.amount)})` : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {inv.lines.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="einvoice-lines">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-gray-500 dark:text-gray-400">
                        <th className="py-1 pr-2">#</th>
                        <th className="py-1 pr-2">{t("eInvoice.item")}</th>
                        <th className="py-1 pr-2 text-right">{t("eInvoice.quantity")}</th>
                        <th className="py-1 pr-2 text-right">{t("eInvoice.unitPrice")}</th>
                        <th className="py-1 pr-2 text-right">{t("eInvoice.vat")}</th>
                        <th className="py-1 text-right">{t("eInvoice.net")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inv.lines.map((l, i) => (
                        <tr key={`${l.id}-${i}`} className="border-b align-top">
                          <td className="py-1 pr-2 text-gray-500">{l.id || i + 1}</td>
                          <td className="py-1 pr-2">
                            <div>{l.name || "—"}</div>
                            {l.description && <div className="text-xs text-gray-500 dark:text-gray-400">{l.description}</div>}
                          </td>
                          <td className="py-1 pr-2 text-right whitespace-nowrap">
                            {num(l.quantity)} {l.unit ? UNITS[l.unit] || l.unit : ""}
                          </td>
                          <td className="py-1 pr-2 text-right font-mono">{money(l.unitPrice)}</td>
                          <td className="py-1 pr-2 text-right">{l.taxRate != null ? `${num(l.taxRate)} %` : ""}</td>
                          <td className="py-1 text-right font-mono">{money(l.netAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex justify-end">
                <table className="text-sm" data-testid="einvoice-totals">
                  <tbody>
                    {inv.taxGroups.map((g) => (
                      <tr key={`${g.category}-${g.rate}`}>
                        <td className="pr-6 text-gray-500 dark:text-gray-400">
                          {t("eInvoice.net")} {g.category === "S" ? `${num(g.rate)} %` : t(`eInvoice.category.${g.category}`)}
                          {g.exemptionReason ? ` (${g.exemptionReason})` : ""}
                        </td>
                        <td className="text-right font-mono pr-4">{money(g.taxableAmount)}</td>
                        <td className="text-right font-mono">{money(g.taxAmount)}</td>
                      </tr>
                    ))}
                    <tr className="border-t font-semibold">
                      <td className="pr-6">{t("eInvoice.gross")}</td>
                      <td />
                      <td className="text-right font-mono" data-testid="einvoice-gross">{money(inv.totals.gross)}</td>
                    </tr>
                    {inv.totals.payable != null && inv.totals.payable !== inv.totals.gross && (
                      <tr>
                        <td className="pr-6">{t("eInvoice.payable")}</td>
                        <td />
                        <td className="text-right font-mono">{money(inv.totals.payable)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {inv.notes.length > 0 && <div className="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap">{inv.notes.join("\n")}</div>}

              {preview && (
                <div className="border rounded p-3 bg-gray-50 dark:bg-gray-800 space-y-2">
                  <div className="font-semibold">{t("eInvoice.willCreate")}</div>
                  {preview.expenses.map((e) => (
                    <div key={e.description} data-testid="einvoice-planned">
                      <div className="flex justify-between gap-4">
                        <span>{e.description}</span>
                        <span className="font-mono whitespace-nowrap">
                          {money(e.netAmount, "EUR")} + {money(e.vatAmount, "EUR")} = {money(e.grossAmount, "EUR")}
                        </span>
                      </div>
                      {(e.taxLines ?? []).map((l) => (
                        <div key={l.vatRate} className="flex justify-between gap-4 pl-4 text-xs text-gray-600 dark:text-gray-300" data-testid="einvoice-planned-line">
                          <span>{num(l.vatRate * 100)} %</span>
                          <span className="font-mono whitespace-nowrap">
                            {money(l.netAmount, "EUR")} + {money(l.vatAmount, "EUR")}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                  {foreign && (
                    <label className="flex flex-wrap items-center gap-2">
                      <span>
                        {t("eInvoice.exchangeRate")} (1 EUR = … {inv.currency})
                      </span>
                      <input
                        value={exchangeRate}
                        onChange={(e) => setExchangeRate(e.target.value)}
                        inputMode="decimal"
                        className="border rounded px-2 py-1 w-28 dark:bg-gray-900"
                        data-testid="einvoice-exchange-rate"
                      />
                      <Button variant="outline" size="sm" onClick={() => loadPreview(exchangeRate)}>
                        {t("eInvoice.recalculate")}
                      </Button>
                    </label>
                  )}
                  {needsDuplicate && (
                    <label className="flex items-start gap-2 text-yellow-900 dark:text-yellow-100">
                      <input type="checkbox" checked={confirmDuplicate} onChange={(e) => setConfirmDuplicate(e.target.checked)} data-testid="einvoice-confirm-duplicate" className="mt-1" />
                      <span>
                        {preview.duplicate!.message} {t("eInvoice.confirmDuplicate")}
                      </span>
                    </label>
                  )}
                  {needsRecipient && (
                    <label className="flex items-start gap-2 text-yellow-900 dark:text-yellow-100">
                      <input type="checkbox" checked={confirmRecipient} onChange={(e) => setConfirmRecipient(e.target.checked)} data-testid="einvoice-confirm-recipient" className="mt-1" />
                      <span>{t("eInvoice.confirmRecipient")}</span>
                    </label>
                  )}
                  <label className="flex flex-wrap items-center gap-2">
                    <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} data-testid="einvoice-paid" />
                    <span>{t("eInvoice.alreadyPaid")}</span>
                    {paid && (
                      <input type="date" value={paidAt} max={todayIso()} onChange={(e) => setPaidAt(e.target.value)} className="border rounded px-2 py-1 dark:bg-gray-900" />
                    )}
                  </label>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{t("eInvoice.keptAsReceived")}</div>
                </div>
              )}

              {check && check !== "running" && (
                <div
                  className={`p-3 rounded border text-sm ${
                    check.failed || check.valid === false
                      ? "border-red-300 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
                      : check.available
                        ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                        : "border-gray-300 bg-gray-50 text-gray-700 dark:bg-gray-800 dark:text-gray-200"
                  }`}
                  data-testid="einvoice-check-result"
                  data-available={check.available ? "1" : "0"}
                >
                  {check.failed
                    ? `${t("eInvoice.checkFailed")} ${check.failed}`
                    : !check.available
                      ? t("eInvoice.checkUnavailable")
                      : check.valid
                        ? t("eInvoice.checkValid")
                        : t("eInvoice.checkInvalid")}
                  {check.available && !check.failed && (check.errors?.length ?? 0) > 0 && (
                    <ul className="mt-2 list-disc pl-5 space-y-1">
                      {check.errors!.slice(0, 50).map((e, i) => (
                        <li key={i}>
                          {e.rule ? <span className="font-mono">{e.rule}: </span> : null}
                          {e.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                {mode.kind === "import" && (
                  <Button variant="outline" onClick={runCheck} disabled={check === "running"} className="mr-auto" data-testid="einvoice-check-button">
                    {check === "running" ? t("eInvoice.checking") : t("eInvoice.check")}
                  </Button>
                )}
                <Button variant="outline" onClick={onClose}>
                  {mode.kind === "import" ? t("common.cancel") : t("common.close")}
                </Button>
                {mode.kind === "import" && (
                  <Button onClick={doImport} disabled={!canImport} data-testid="einvoice-import-button">
                    {t("eInvoice.import")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
