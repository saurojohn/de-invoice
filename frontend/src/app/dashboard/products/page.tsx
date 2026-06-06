"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { ExportCSVButton } from "@/components/ExportCSVButton"
import { Switch } from "@/components/ui/switch"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from "@/lib/api"

interface Product {
  id: string
  name: string
  sku: string
  type: string
  unit: string
  basePrice: string
  vatRate: string
  description?: string | null
  category?: { name: string } | null
  active: boolean
  stockQuantity?: string
  lowStockThreshold?: string
  trackInventory?: boolean
}

export default function ProductsPage() {
  const router = useRouter()
  const { t } = useI18n()
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)

  // Save / error state for the modal
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null)

  // Re-fetch whenever page or debounced search changes.
  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) { router.push("/login"); return }
    const params = new URLSearchParams({
      companyId,
      page: String(page),
      pageSize: String(pageSize),
    })
    if (search.trim()) params.append('search', search.trim())
    setLoading(true)
    apiGet<any>(`/api/v1/products?${params}`)
      .then((data) => {
        setProducts(data.data || [])
        setTotal(data.total || 0)
        setTotalPages(data.totalPages || 1)
      })
      .catch((err) => {
        console.error('Products list fetch failed:', err)
        setProducts([])
        setTotal(0)
        setTotalPages(1)
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, page, search])

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300)
    return () => clearTimeout(t)
  }, [searchInput])
  useEffect(() => {
    if (page !== 1) setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])
  const [form, setForm] = useState({
    name: "",
    sku: "",
    type: "good",
    unit: "Stück",
    basePrice: "",
    vatRate: "0.19",
    description: "",
    stockQuantity: "0",
    lowStockThreshold: "",
    trackInventory: false,
  })

  const openModal = (product?: Product) => {
    setSaveError(null)
    if (product) {
      setEditingProduct(product)
      setForm({
        name: product.name,
        sku: product.sku || "",
        type: product.type,
        unit: product.unit,
        basePrice: product.basePrice,
        vatRate: product.vatRate,
        description: product.description || "",
        stockQuantity: product.stockQuantity || "0",
        lowStockThreshold: product.lowStockThreshold || "",
        trackInventory: product.trackInventory || false,
      })
    } else {
      setEditingProduct(null)
      setForm({
        name: "",
        sku: "",
        type: "good",
        unit: "Stück",
        basePrice: "",
        vatRate: "0.19",
        description: "",
        stockQuantity: "0",
        lowStockThreshold: "",
        trackInventory: false,
      })
    }
    setShowModal(true)
  }

  /**
   * Reload the list (page 1, no search) — used after every mutation
   * so the user sees the new state immediately.
   */
  const reload = async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    const params = new URLSearchParams({
      companyId,
      page: "1",
      pageSize: String(pageSize),
    })
    try {
      const d = await apiGet<any>(`/api/v1/products?${params}`)
      setProducts(d.data || [])
      setTotal(d.total || 0)
      setTotalPages(d.totalPages || 1)
      setPage(1)
    } catch (err) {
      console.error('Products reload failed:', err)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setSaveError("Kein Unternehmen ausgewählt")
      return
    }
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(null)

    const data = {
      name: form.name,
      sku: form.sku || null,
      type: form.type,
      unit: form.unit,
      basePrice: parseFloat(form.basePrice) || 0,
      vatRate: parseFloat(form.vatRate) || 0,
      description: form.description || null,
      stockQuantity: parseFloat(form.stockQuantity) || 0,
      lowStockThreshold: form.lowStockThreshold ? parseFloat(form.lowStockThreshold) : null,
      trackInventory: form.trackInventory,
    }

    try {
      if (editingProduct) {
        await apiPut(`/api/v1/products/${editingProduct.id}?companyId=${companyId}`, data)
        setSaveSuccess(t("common.save") + " ✓")
      } else {
        await apiPost(`/api/v1/products?companyId=${companyId}`, data)
        setSaveSuccess(t("common.create") + " ✓")
      }
      setShowModal(false)
      setSearch("")
      setSearchInput("")
      await reload()
      setTimeout(() => setSaveSuccess(null), 3000)
    } catch (err) {
      if (err instanceof ApiError) {
        setSaveError(err.message)
      } else {
        setSaveError(`Netzwerkfehler: ${err}`)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (product: Product) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    if (!confirm(`${t("common.delete")} — ${product.name}?`)) return
    try {
      const result = await apiDelete<{ ok?: boolean; soft?: boolean; usedInInvoices?: number }>(
        `/api/v1/products/${product.id}?companyId=${companyId}`
      )
      // Soft-deleted products disappear from the list (the API only
      // returns active=true), so just refetch. Show a hint if the
      // backend soft-archived it because of historical references.
      if (result?.soft) {
        alert(
          `Produkt wird in ${result.usedInInvoices} Rechnung(en) verwendet und wurde archiviert (nicht endgültig gelöscht).`
        )
      }
      await reload()
    } catch (err) {
      if (err instanceof ApiError) {
        alert(err.message)
      } else {
        alert(`Netzwerkfehler: ${err}`)
      }
    }
  }

  const getVatLabel = (rate: string) => {
    const r = parseFloat(rate)
    if (r === 0.19) return t("product.standard")
    if (r === 0.07) return t("product.reduced")
    return t("product.zero")
  }

  const getTypeLabel = (type: string) => {
    return type === "good" ? t("product.typeGood") : t("product.typeService")
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-blue-600">{t("product.title")}</h1>
          <div className="flex gap-2 items-center">
            <LanguageSwitcher />
            <ExportCSVButton
              data={products}
              filename="produkte"
              label={t("common2.exportCsv") || "CSV"}
              columns={[
                { header: "Artikelnummer", accessor: (p) => p.sku || "" },
                { header: "Name", accessor: (p) => p.name },
                { header: "Typ", accessor: (p) => p.type },
                { header: "Kategorie", accessor: (p) => p.category?.name || "" },
                { header: "Einheit", accessor: (p) => p.unit || "" },
                { header: "Grundpreis", accessor: (p) => p.basePrice },
                { header: "MwSt-Satz", accessor: (p) => p.vatRate },
                { header: "Beschreibung", accessor: (p) => p.description || "" },
              ]}
            />
            <Button variant="outline" onClick={() => router.push("/dashboard")}>{t("common.back")}</Button>
            <Button onClick={() => openModal()}>{t("product.create")}</Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {!loading && (
          <div className="mb-4">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("product.searchPlaceholder") || "Name, SKU, Kategorie suchen..."}
              className="w-full md:w-1/2 px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            {search && (
              <p className="text-xs text-gray-500 mt-1">
                {products.length} Treffer
              </p>
            )}
          </div>
        )}
        {loading ? (
          <div className="text-center py-8">{t("common.loading")}</div>
        ) : products.length === 0 && !search ? (
          // Empty state — no products AND no search active
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-gray-500 mb-4">{t("product.noProducts")}</p>
              <Button onClick={() => openModal()}>{t("product.addFirst")}</Button>
            </CardContent>
          </Card>
        ) : products.length === 0 ? (
          // Empty state — search yielded no results
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-gray-500 mb-4">{t("product.noMatching") || "Keine Produkte entsprechen der Suche."}</p>
              <Button variant="outline" onClick={() => setSearchInput('')}>
                {t("common2.clearFilters") || "Suche zurücksetzen"}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">{t("product.sku")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">{t("product.name")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">{t("product.type")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">{t("product.unit")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">{t("product.price")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">{t("product.vatRate")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">{t("inventory.stock")}</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-gray-600">{t("inventory.tracking")}</th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-gray-600">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {products.map((product) => (
                  <tr key={product.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">{product.sku || "-"}</td>
                    <td
                      className="px-4 py-3 font-medium cursor-pointer"
                      onClick={() => openModal(product)}
                    >
                      {product.name}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${product.type === "good" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>
                        {getTypeLabel(product.type)}
                      </span>
                    </td>
                    <td className="px-4 py-3">{product.unit}</td>
                    <td className="px-4 py-3">€{parseFloat(product.basePrice).toFixed(2)}</td>
                    <td className="px-4 py-3">{getVatLabel(product.vatRate)}</td>
                    <td className="px-4 py-3">
                      {product.trackInventory ? (
                        <span className={`font-medium ${parseFloat(product.stockQuantity || "0") <= parseFloat(product.lowStockThreshold || "0") ? "text-red-600" : "text-green-600"}`}>
                          {parseFloat(product.stockQuantity || "0").toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {product.trackInventory ? (
                        <span className="px-2 py-1 rounded text-xs bg-green-100 text-green-700">{t("inventory.active")}</span>
                      ) : (
                        <span className="px-2 py-1 rounded text-xs bg-gray-100 text-gray-500">{t("inventory.off")}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openModal(product)}
                        >
                          {t("common.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:text-red-800 hover:bg-red-50"
                          onClick={() => handleDelete(product)}
                          title={t("common.delete") || "Löschen"}
                        >
                          🗑
                        </Button>
                      </div>
                    </td>
                   </tr>
                 ))}
               </tbody>
             </table>
           </div>
         )}

         {totalPages > 1 && (
           <div className="flex items-center justify-between mt-4 text-sm">
             <span className="text-gray-600">
               Seite {page} / {totalPages} ({total} gesamt)
             </span>
             <div className="flex gap-2">
               <Button
                 variant="outline"
                 size="sm"
                 disabled={page <= 1}
                 onClick={() => setPage((p) => Math.max(1, p - 1))}
               >
                 ← Zurück
               </Button>
               <Button
                 variant="outline"
                 size="sm"
                 disabled={page >= totalPages}
                 onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
               >
                 Weiter →
               </Button>
             </div>
           </div>
         )}

         {/* Page-level success toast — appears after a successful create/update */}
         {saveSuccess && (
           <div className="fixed bottom-6 right-6 bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-3 rounded-lg shadow-lg z-50">
             ✓ {saveSuccess}
           </div>
         )}
       </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-lg">
            <CardHeader>
              <CardTitle>{editingProduct ? t("product.edit") : t("product.create")}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("product.name")} *</label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="z.B. Beratungsleistung"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("product.description") || "Beschreibung"}</label>
                  <Input
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Optional"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("product.sku")}</label>
                    <Input
                      value={form.sku}
                      onChange={(e) => setForm({ ...form, sku: e.target.value })}
                      placeholder="PRD-001"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("product.type")}</label>
                    <select
                      className="w-full h-10 border rounded-md px-3"
                      value={form.type}
                      onChange={(e) => setForm({ ...form, type: e.target.value })}
                    >
                      <option value="good">{t("product.typeGood")}</option>
                      <option value="service">{t("product.typeService")}</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("product.unit")}</label>
                    <Input
                      value={form.unit}
                      onChange={(e) => setForm({ ...form, unit: e.target.value })}
                      placeholder="Stück/Stunde/Projekt"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("product.price")} (€) *</label>
                    <Input
                      type="number"
                      step="0.01"
                      value={form.basePrice}
                      onChange={(e) => setForm({ ...form, basePrice: e.target.value })}
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">{t("product.vatRate")}</label>
                    <select
                      className="w-full h-10 border rounded-md px-3"
                      value={form.vatRate}
                      onChange={(e) => setForm({ ...form, vatRate: e.target.value })}
                    >
                      <option value="0.19">19% {t("product.standard")}</option>
                      <option value="0.07">7% {t("product.reduced")}</option>
                      <option value="0">0% {t("product.zero")}</option>
                    </select>
                  </div>
                </div>

                {/* Inventory Section */}
                <div className="border-t pt-4 mt-4">
                  <h3 className="text-sm font-medium mb-3">{t("inventory.tracking")}</h3>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="font-medium">{t("inventory.trackProduct")}</p>
                      <p className="text-xs text-gray-500">{t("inventory.trackHint")}</p>
                    </div>
                    <Switch
                      checked={form.trackInventory}
                      onCheckedChange={(checked) => setForm({ ...form, trackInventory: checked })}
                    />
                  </div>

                  {form.trackInventory && (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium mb-1">{t("inventory.currentStock")}</label>
                        <Input
                          type="number"
                          step="0.01"
                          value={form.stockQuantity}
                          onChange={(e) => setForm({ ...form, stockQuantity: e.target.value })}
                          placeholder="0"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium mb-1">{t("inventory.threshold")}</label>
                        <Input
                          type="number"
                          step="0.01"
                          value={form.lowStockThreshold}
                          onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })}
                          placeholder="10"
                        />
                        <p className="text-xs text-gray-500 mt-1">{t("inventory.thresholdHint")}</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Inline error feedback inside the modal */}
                {saveError && (
                  <div
                    className="bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded text-sm"
                    role="alert"
                  >
                    ⚠ {saveError}
                  </div>
                )}

                <div className="flex gap-4 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setShowModal(false)
                      setSaveError(null)
                    }}
                    disabled={saving}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" className="flex-1" disabled={saving}>
                    {saving ? "…" : (editingProduct ? t("common.save") : t("common.create"))}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  )
}
