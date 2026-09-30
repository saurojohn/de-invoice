"use client"

/**
 * Tier 484 — VAT paid to / refunded by the Finanzamt outside a UStVA: the
 * annual return's Abschlusszahlung / Erstattung (UStJA), the Sondervoraus-
 * zahlung under Dauerfristverlängerung, anything else. A UStVA's own payment
 * is recorded on its row in the history (Tier 483). The EÜR counts both on
 * the day the money moved (Anlage EÜR Zeilen 18 / 58).
 */
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { apiDelete, apiGet, apiPost } from "@/lib/api"

interface UstPayment {
  id: string
  kind: "ustja" | "sondervorauszahlung" | "sonstige"
  year: number
  paidAt: string
  amount: string
  note: string | null
}

const eur = (n: number) => n.toLocaleString("de-DE", { style: "currency", currency: "EUR" })

export default function UstPaymentsCard() {
  const { t } = useI18n()
  const [rows, setRows] = useState<UstPayment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    kind: "ustja" as UstPayment["kind"],
    year: String(new Date().getFullYear() - 1),
    paidAt: new Date().toISOString().slice(0, 10),
    amount: "",
    note: "",
  })

  const companyId = () => (typeof window !== "undefined" ? localStorage.getItem("companyId") : null)

  const load = async () => {
    try {
      const list = await apiGet<UstPayment[]>(`/api/v1/ustva/payments?companyId=${companyId()}`)
      setRows(Array.isArray(list) ? list : [])
    } catch (e: any) {
      setError(e?.message || t("ustva.otherPaymentsFailed"))
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const add = async () => {
    const amount = Number(form.amount.replace(",", "."))
    if (!amount || !form.paidAt) return
    setSaving(true)
    setError(null)
    try {
      await apiPost(`/api/v1/ustva/payments?companyId=${companyId()}`, {
        kind: form.kind,
        year: Number(form.year),
        paidAt: form.paidAt,
        amount,
        note: form.note || undefined,
      })
      setForm((f) => ({ ...f, amount: "", note: "" }))
      await load()
    } catch (e: any) {
      setError(e?.message || t("ustva.otherPaymentsFailed"))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    setError(null)
    try {
      await apiDelete(`/api/v1/ustva/payments/${id}?companyId=${companyId()}`)
      await load()
    } catch (e: any) {
      setError(e?.message || t("ustva.otherPaymentsFailed"))
    }
  }

  const kindLabel = (k: UstPayment["kind"]) =>
    k === "ustja" ? t("ustva.kindUstja") : k === "sondervorauszahlung" ? t("ustva.kindSonder") : t("ustva.kindSonstige")

  return (
    <Card className="mt-6" data-testid="ust-payments-card">
      <CardHeader>
        <CardTitle>{t("ustva.otherPayments")}</CardTitle>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("ustva.otherPaymentsHint")}</p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-2 mb-4">
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("ustva.kind")}</span>
            <select
              className="border rounded px-2 py-1 bg-white dark:bg-gray-800"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as UstPayment["kind"] })}
              data-testid="ust-payment-kind"
            >
              <option value="ustja">{t("ustva.kindUstja")}</option>
              <option value="sondervorauszahlung">{t("ustva.kindSonder")}</option>
              <option value="sonstige">{t("ustva.kindSonstige")}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("ustva.taxYear")}</span>
            <input
              type="number"
              className="border rounded px-2 py-1 w-24 bg-white dark:bg-gray-800"
              value={form.year}
              onChange={(e) => setForm({ ...form, year: e.target.value })}
              data-testid="ust-payment-year"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("ustva.paidOnDate")}</span>
            <input
              type="date"
              className="border rounded px-2 py-1 bg-white dark:bg-gray-800"
              value={form.paidAt}
              onChange={(e) => setForm({ ...form, paidAt: e.target.value })}
              data-testid="ust-payment-date"
            />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{t("ustva.amountSigned")}</span>
            <input
              className="border rounded px-2 py-1 w-32 bg-white dark:bg-gray-800"
              value={form.amount}
              placeholder="-150,00"
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              data-testid="ust-payment-amount"
            />
          </label>
          <label className="text-sm flex-1 min-w-40">
            <span className="block text-gray-600 dark:text-gray-300">{t("ustva.note")}</span>
            <input
              className="border rounded px-2 py-1 w-full bg-white dark:bg-gray-800"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </label>
          <Button size="sm" onClick={add} disabled={saving} data-testid="ust-payment-add">
            {t("ustva.addPayment")}
          </Button>
        </div>
        {error && <div className="mb-3 text-sm text-red-700">{error}</div>}
        {rows.length === 0 ? (
          <p className="text-sm text-gray-500">{t("ustva.noOtherPayments")}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b" data-testid={`ust-payment-${r.id}`}>
                  <td className="py-2">{new Date(r.paidAt).toLocaleDateString("de-DE")}</td>
                  <td className="py-2">
                    {kindLabel(r.kind)} {r.year}
                  </td>
                  <td className="py-2 text-gray-600 dark:text-gray-300">{r.note || ""}</td>
                  <td className="py-2 text-right">
                    {Number(r.amount) < 0 ? t("ustva.refunded") : t("ustva.paid")} {eur(Math.abs(Number(r.amount)))}
                  </td>
                  <td className="py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => remove(r.id)}>
                      {t("ustva.delete")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}
