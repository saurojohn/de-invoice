"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api"

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
  const router = (typeof window !== "undefined" ? (window as any).next?.router : null)
  // Use the standard router hook instead:
  // (re-import below)
  const { t } = useI18n()

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [search, setSearch] = useState("")
  const [form, setForm] = useState({ ...emptyForm })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{t("suppliers.title")}</h1>
            <p className="text-gray-500 mt-1">{t("suppliers.subtitle")}</p>
          </div>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <Button variant="outline" onClick={() => window.history.back()}>
              {t("common.back")}
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
            className="w-full max-w-md px-3 py-2 border border-gray-300 rounded"
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
                  <tr className="text-left text-gray-500 text-xs border-b">
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
                    <tr key={s.id} className="border-b hover:bg-gray-50">
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
                            className="text-red-700"
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
                <div className="text-sm text-gray-500 text-center py-8">
                  {t("suppliers.empty")}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Edit/Create modal */}
        {showModal && (
          <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
              <h2 className="text-xl font-bold mb-4">
                {editing ? t("suppliers.editTitle") : t("suppliers.addTitle")}
              </h2>
              {error && (
                <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">
                  {error}
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div className="md:col-span-2">
                  <label className="block text-gray-600 mb-1">{t("suppliers.name")} *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-2 py-1 border border-gray-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 mb-1">{t("suppliers.vatId")}</label>
                  <input
                    type="text"
                    value={form.vatId}
                    onChange={(e) => setForm({ ...form, vatId: e.target.value })}
                    className="w-full px-2 py-1 border border-gray-300 rounded font-mono"
                    placeholder="DE123456789"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 mb-1">{t("suppliers.paymentTerms")}</label>
                  <input
                    type="number"
                    value={form.paymentTerms}
                    onChange={(e) => setForm({ ...form, paymentTerms: Number(e.target.value) })}
                    className="w-full px-2 py-1 border border-gray-300 rounded"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-gray-600 mb-1">{t("suppliers.street")}</label>
                  <input
                    type="text"
                    value={form.address?.street || ""}
                    onChange={(e) =>
                      setForm({ ...form, address: { ...form.address, street: e.target.value } })
                    }
                    className="w-full px-2 py-1 border border-gray-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 mb-1">{t("suppliers.postalCode")}</label>
                  <input
                    type="text"
                    value={form.address?.postalCode || ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        address: { ...form.address, postalCode: e.target.value },
                      })
                    }
                    className="w-full px-2 py-1 border border-gray-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 mb-1">{t("suppliers.city")}</label>
                  <input
                    type="text"
                    value={form.address?.city || ""}
                    onChange={(e) =>
                      setForm({ ...form, address: { ...form.address, city: e.target.value } })
                    }
                    className="w-full px-2 py-1 border border-gray-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 mb-1">{t("suppliers.email")}</label>
                  <input
                    type="email"
                    value={form.contact?.email || ""}
                    onChange={(e) =>
                      setForm({ ...form, contact: { ...form.contact, email: e.target.value } })
                    }
                    className="w-full px-2 py-1 border border-gray-300 rounded"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 mb-1">{t("suppliers.iban")}</label>
                  <input
                    type="text"
                    value={form.bankInfo?.iban || ""}
                    onChange={(e) =>
                      setForm({ ...form, bankInfo: { ...form.bankInfo, iban: e.target.value } })
                    }
                    className="w-full px-2 py-1 border border-gray-300 rounded font-mono"
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
      </div>
    </div>
  )
}
