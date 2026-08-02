"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { VatCheckPanel } from "@/components/VatCheckPanel"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "@/lib/api"

interface Supplier {
  id: string
  name: string
  vatId: string | null
  address: any
  contact: any
  bankInfo: any
  paymentTerms: number
  createdAt: string
  _count?: { expenses: number }
}

const emptyForm = {
  name: "",
  vatId: "",
  address: { street: "", postalCode: "", city: "", country: "Deutschland" },
  contact: { email: "", phone: "" },
  bankInfo: { iban: "", bic: "", bankName: "" },
  paymentTerms: 30,
}

export default function SuppliersPage() {
  const router = useRouter()
  const { t } = useI18n()

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [search, setSearch] = useState("")
  const [form, setForm] = useState({ ...emptyForm })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Tier 137: VIES batch check modal state.
  // Same UX as /dashboard/customers (Tier 134) but
  // for the supplier list — `entityType: 'supplier'`
  // tells the backend to walk the Supplier table.
  const [viesBatch, setViesBatch] = useState<{
    state: "idle" | "running" | "done" | "error"
    result?: {
      total: number
      valid: number
      invalid: number
      unreachable: number
      skipped: number
      durationMs: number
      results: Array<{
        entityId: string
        entityName: string
        vatId: string
        status: "valid" | "invalid" | "unreachable" | "pending"
        cached: boolean
        errorMessage: string | null
        durationMs: number
      }>
    }
    error?: string
  }>({ state: "idle" })
  const [showViesBatchModal, setShowViesBatchModal] = useState(false)
  // Read once on mount so the VAT-ID panel below the
  // form fields has a stable companyId prop. (The
  // per-handler pattern in `reload`/`handleSubmit` is
  // fine for the data path, but the panel needs the
  // value at render time, not just when reload fires.)
  const [companyId, setCompanyId] = useState<string>("")
  useEffect(() => {
    const cid = localStorage.getItem("companyId") || ""
    if (cid) setCompanyId(cid)
  }, [])

  const reload = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      if (typeof window !== "undefined") window.location.href = "/login"
      return
    }
    setLoading(true)
    try {
      const q = search ? `?companyId=${companyId}&search=${encodeURIComponent(search)}` : `?companyId=${companyId}`
      const data = await apiGet<any>(`/api/v1/suppliers${q}`)
      setSuppliers(Array.isArray(data) ? data : data.data || [])
    } catch (e: any) {
      console.error("Suppliers list fetch failed:", e)
      setSuppliers([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCreate = () => {
    setEditing(null)
    setForm({ ...emptyForm })
    setError(null)
    setShowModal(true)
  }

  const openEdit = (s: Supplier) => {
    setEditing(s)
    setForm({
      name: s.name,
      vatId: s.vatId || "",
      address: s.address || emptyForm.address,
      contact: s.contact || emptyForm.contact,
      bankInfo: s.bankInfo || emptyForm.bankInfo,
      paymentTerms: s.paymentTerms,
    })
    setError(null)
    setShowModal(true)
  }

  const save = async () => {
    const companyId = localStorage.getItem("companyId") || ""
    if (!form.name.trim()) {
      setError("Name ist erforderlich")
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await apiPut(`/api/v1/suppliers/${editing.id}?companyId=${companyId}`, form)
      } else {
        await apiPost(`/api/v1/suppliers?companyId=${companyId}`, form)
      }
      setShowModal(false)
      await reload()
    } catch (e: any) {
      setError(e?.message || "Speichern fehlgeschlagen")
    } finally {
      setSaving(false)
    }
  }

  const remove = async (s: Supplier) => {
    if (!confirm(t("suppliers.deleteConfirm").replace("{name}", s.name))) return
    const companyId = localStorage.getItem("companyId") || ""
    try {
      await apiDelete(`/api/v1/suppliers/${s.id}?companyId=${companyId}`)
      await reload()
    } catch (e: any) {
      alert(e?.message || "Löschen fehlgeschlagen")
    }
  }

  // Tier 137: run VIES batch check for all suppliers
  // with a VAT ID. Reuses the same backend endpoint
  // Tier 134 added — `entityType: 'supplier'`
  // switches it to walk the Supplier table.
  const startViesBatch = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setViesBatch({ state: "running" })
    try {
      const data = await apiPost<{
        total: number
        valid: number
        invalid: number
        unreachable: number
        skipped: number
        durationMs: number
        results: Array<{
          entityId: string
          entityName: string
          vatId: string
          status: "valid" | "invalid" | "unreachable" | "pending"
          cached: boolean
          errorMessage: string | null
          durationMs: number
        }>
      }>("/api/v1/vat-validation/batch-check", {
        companyId,
        entityType: "supplier",
        limit: 100,
      })
      setViesBatch({ state: "done", result: data })
    } catch (err) {
      setViesBatch({
        state: "error",
        error: err instanceof ApiError ? err.message : String(err),
      })
    }
  }

  const closeViesBatch = () => {
    setShowViesBatchModal(false)
    setTimeout(() => setViesBatch({ state: "idle" }), 200)
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">{t("suppliers.title")}</h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">{t("suppliers.subtitle")}</p>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>
              {t("common.back")}
            </Button>
            {/* Tier 137: VIES batch check. Same
                endpoint + UX as the customers list
                (Tier 134) but walks the Supplier
                table instead. Slow (1-2s per
                supplier) so the modal shows
                progress + summary at the end. */}
            <Button
              variant="outline"
              onClick={() => setShowViesBatchModal(true)}
              data-testid="supplier-vies-batch-button"
            >
              🔍 {t("customer.vatBatchCheck") || "Alle USt-IDs prüfen"}
            </Button>
            <Button onClick={openCreate}>{t("suppliers.add")}</Button>
          </div>
        </div>

        <div className="mb-4">
          <input
            type="text"
            placeholder={t("suppliers.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && reload()}
            className="w-full max-w-md px-3 py-2 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded"
            data-testid="supplier-search-input"
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {loading ? t("common.loading") : `${suppliers.length} ${t("suppliers.count")}`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400 text-xs border-b">
                    <th className="py-2">{t("suppliers.name")}</th>
                    <th>{t("suppliers.vatId")}</th>
                    <th>{t("suppliers.city")}</th>
                    <th className="text-right">{t("suppliers.paymentTerms")}</th>
                    <th className="text-right">{t("suppliers.expenses")}</th>
                    <th className="text-right">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((s) => (
                    <tr key={s.id} className="border-b hover:bg-gray-50 dark:bg-gray-900" data-testid="supplier-row" data-supplier-name={s.name}>
                      <td className="py-2 font-medium">{s.name}</td>
                      <td className="font-mono text-xs">{s.vatId || "—"}</td>
                      <td className="text-xs">
                        {s.address?.city || "—"}
                      </td>
                      <td className="text-right text-xs">{s.paymentTerms} d</td>
                      <td className="text-right text-xs">
                        {s._count?.expenses ?? "—"}
                      </td>
                      <td className="text-right">
                        <div className="flex gap-2 justify-end">
                          <Button size="sm" variant="outline" onClick={() => openEdit(s)}>
                            {t("common.edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => remove(s)}
                            className="text-red-700 dark:text-red-300"
                          >
                            {t("common.delete")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!loading && suppliers.length === 0 && (
                <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                  {t("suppliers.empty")}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Edit/Create modal */}
        {showModal && (
          <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
              <h2 className="text-xl font-bold mb-4">
                {editing ? t("suppliers.editTitle") : t("suppliers.addTitle")}
              </h2>
              {error && (
                <div className="mb-3 text-sm text-red-700 dark:text-red-300 bg-red-50 border border-red-200 rounded p-2">
                  {error}
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="md:col-span-2">
                  <label className="block text-gray-600 dark:text-gray-300 mb-1">{t("suppliers.name")} *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-2 py-1 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded"
                  />
                </div>
                <div>
                   <label className="block text-gray-600 dark:text-gray-300 mb-1">{t("suppliers.vatId")}</label>
                   <input
                     type="text"
                     value={form.vatId}
                     onChange={(e) => setForm({ ...form, vatId: e.target.value })}
                     className="w-full px-2 py-1 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded font-mono"
                     placeholder="DE123456789"
                   />
                 </div>
                 {/* VIES VAT-ID verification panel — same
                     component as the customer modal uses.
                     Edit-mode only (verify is per-row, not
                     per-VAT-string); the form's vatId field
                     is the source of truth that the panel
                     watches via props. */}
                 {editing && (
                   <VatCheckPanel
                     companyId={companyId}
                     entityType="supplier"
                     entityId={editing.id}
                     vatId={form.vatId}
                     labels={{
                       title: t("suppliers.vatCheckTitle") || "USt-ID-Prüfung (VIES)",
                       check: t("suppliers.vatCheckNow") || "Jetzt prüfen",
                       checking: t("suppliers.vatChecking") || "Prüfe…",
                       noVat:
                         t("suppliers.vatCheckNoVat") ||
                         "Keine USt-ID hinterlegt. Tragen Sie oben eine USt-ID ein, um die VIES-Prüfung zu aktivieren.",
                       statusNone: t("suppliers.vatStatusNone") || "Noch nicht geprüft",
                       statusValid: t("suppliers.vatStatusValid") || "Gültig",
                       statusInvalid: t("suppliers.vatStatusInvalid") || "Ungültig",
                       statusUnreachable:
                         t("suppliers.vatStatusUnreachable") || "VIES nicht erreichbar",
                       statusPending: t("suppliers.vatStatusPending") || "Warte auf Ergebnis",
                       cached: t("suppliers.vatCached") || "aus Cache",
                       fresh: t("suppliers.vatFresh") || "frisch geprüft",
                       history: t("suppliers.vatHistory") || "Verlauf",
                       noHistory: t("suppliers.vatNoHistory") || "Keine Prüfungen bisher",
                       errorPrefix: t("suppliers.vatErrorPrefix") || "Fehler",
                       checkedAt: t("suppliers.vatCheckedAt") || "Geprüft am",
                       duration: t("suppliers.vatDuration") || "Dauer",
                     }}
                   />
                 )}
                <div>
                  <label className="block text-gray-600 dark:text-gray-300 mb-1">{t("suppliers.paymentTerms")}</label>
                  <input
                    type="number"
                    value={form.paymentTerms}
                    onChange={(e) => setForm({ ...form, paymentTerms: Number(e.target.value) })}
                    className="w-full px-2 py-1 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-gray-600 dark:text-gray-300 mb-1">{t("suppliers.street")}</label>
                  <input
                    type="text"
                    value={form.address?.street || ""}
                    onChange={(e) =>
                      setForm({ ...form, address: { ...form.address, street: e.target.value } })
                    }
                    className="w-full px-2 py-1 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 dark:text-gray-300 mb-1">{t("suppliers.postalCode")}</label>
                  <input
                    type="text"
                    value={form.address?.postalCode || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        address: { ...form.address, postalCode: e.target.value },
                      })
                    }
                    className="w-full px-2 py-1 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 dark:text-gray-300 mb-1">{t("suppliers.city")}</label>
                  <input
                    type="text"
                    value={form.address?.city || ""}
                    onChange={(e) =>
                      setForm({ ...form, address: { ...form.address, city: e.target.value } })
                    }
                    className="w-full px-2 py-1 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 dark:text-gray-300 mb-1">{t("suppliers.email")}</label>
                  <input
                    type="email"
                    value={form.contact?.email || ""}
                    onChange={(e) =>
                      setForm({ ...form, contact: { ...form.contact, email: e.target.value } })
                    }
                    className="w-full px-2 py-1 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 dark:text-gray-300 mb-1">{t("suppliers.iban")}</label>
                  <input
                    type="text"
                    value={form.bankInfo?.iban || ""}
                    onChange={(e) =>
                      setForm({ ...form, bankInfo: { ...form.bankInfo, iban: e.target.value } })
                    }
                    className="w-full px-2 py-1 border border-gray dark:border-gray-700-300 dark:border-gray-600 rounded font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <Button variant="outline" onClick={() => setShowModal(false)}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={save} disabled={saving}>
                  {saving ? t("common.loading") : t("common.save")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Tier 137: VIES batch check modal for suppliers.
            Same UX as /dashboard/customers — state
            machine: idle → running (spinner) → done
            (4-tile summary + scrollable result table)
            / error. The result rows link to each
            supplier's edit modal (the existing single-
            row VIES panel inside the edit form is
            where per-supplier verification lives). */}
        {showViesBatchModal && (
          <div
            className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
            onClick={() => viesBatch.state !== "running" && closeViesBatch()}
            data-testid="supplier-vies-batch-modal"
          >
            <div
              className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-[90vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-lg font-semibold mb-1">
                🔍 {t("customer.vatBatchCheckTitle") || "Alle USt-IDs prüfen (VIES)"}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                {t("customer.vatBatchCheckDesc") ||
                  "Validiert jede USt-ID mit dem VIES-System. 1-2 Sekunden pro Lieferant — bei 50 Lieferanten ca. 1-2 Minuten."}
              </p>

              {viesBatch.state === "idle" && (
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={closeViesBatch}>
                    {t("common.cancel") || "Abbrechen"}
                  </Button>
                  <Button
                    onClick={startViesBatch}
                    data-testid="supplier-vies-batch-start"
                  >
                    ▶ {t("customer.vatBatchCheckStart") || "Prüfung starten"}
                  </Button>
                </div>
              )}

              {viesBatch.state === "running" && (
                <div className="py-8 flex flex-col items-center" data-testid="supplier-vies-batch-running">
                  <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-200 border-t-blue-600 mb-4" />
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {t("customer.vatBatchRunning") || "Prüfung läuft… bitte warten."}
                  </p>
                </div>
              )}

              {viesBatch.state === "error" && (
                <div
                  className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm"
                  data-testid="supplier-vies-batch-error"
                >
                  {viesBatch.error}
                </div>
              )}

              {viesBatch.state === "done" && viesBatch.result && (
                <div className="flex-1 overflow-y-auto" data-testid="supplier-vies-batch-done">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                    <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-emerald-700" data-testid="supplier-vies-batch-valid-count">
                        {viesBatch.result.valid}
                      </div>
                      <div className="text-xs text-emerald-700">
                        {t("customer.vatStatusValid") || "Gültig"}
                      </div>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-red-700" data-testid="supplier-vies-batch-invalid-count">
                        {viesBatch.result.invalid}
                      </div>
                      <div className="text-xs text-red-700">
                        {t("customer.vatStatusInvalid") || "Ungültig"}
                      </div>
                    </div>
                    <div className="bg-amber-50 border border-amber-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-amber-700">
                        {viesBatch.result.unreachable}
                      </div>
                      <div className="text-xs text-amber-700">
                        {t("customer.vatStatusUnreachable") || "Nicht erreichbar"}
                      </div>
                    </div>
                    <div className="bg-gray-50 border border-gray-200 rounded p-2 text-center">
                      <div className="text-2xl font-bold text-gray-700">
                        {viesBatch.result.total}
                      </div>
                      <div className="text-xs text-gray-700">
                        {t("customer.vatBatchTotal") || "Geprüft"}
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {t("customer.vatBatchDuration") || "Dauer"}:{" "}
                    {(viesBatch.result.durationMs / 1000).toFixed(1)}s ·{" "}
                    {viesBatch.result.results.filter((r) => r.cached).length}{" "}
                    {t("customer.vatCached") || "aus Cache"}
                  </p>
                  <div className="overflow-x-auto max-h-72 border rounded">
                    <table className="w-full text-sm" data-testid="supplier-vies-batch-results-table">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">
                            {t("suppliers.name") || "Name"}
                          </th>
                          <th className="text-left px-3 py-2 font-medium">
                            {t("customer.vatId") || "USt-ID"}
                          </th>
                          <th className="text-left px-3 py-2 font-medium">
                            {t("customer.colStatus") || "Status"}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {viesBatch.result.results.map((r) => (
                          <tr
                            key={r.entityId}
                            className="border-t border-gray-100"
                            data-testid={`supplier-vies-batch-row-${r.entityId}`}
                          >
                            <td className="px-3 py-2 font-medium">{r.entityName}</td>
                            <td className="px-3 py-2 font-mono text-xs">
                              {r.vatId}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={
                                  r.status === "valid"
                                    ? "text-emerald-700 font-medium"
                                    : r.status === "unreachable"
                                    ? "text-amber-700"
                                    : "text-red-700 font-medium"
                                }
                              >
                                {r.status === "valid"
                                  ? t("customer.vatStatusValid") || "Gültig"
                                  : r.status === "unreachable"
                                  ? t("customer.vatStatusUnreachable") || "Nicht erreichbar"
                                  : t("customer.vatStatusInvalid") || "Ungültig"}
                                {r.cached && (
                                  <span className="ml-1 text-xs text-gray-400">
                                    ({t("customer.vatCached") || "Cache"})
                                  </span>
                                )}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex justify-end mt-4">
                    <Button onClick={closeViesBatch} data-testid="supplier-vies-batch-close">
                      {t("common.close") || "Schließen"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
