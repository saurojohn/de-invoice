"use client"

/**
 * Tier 733b — invoices a restore lost: issued (the customer has them), their
 * kept copy back with the files, their row not in the restored database.
 * Their numbers are retired; here the company sees them, opens the copy and
 * enters each one again from it, under its number. Nothing shows when there
 * are none.
 */
import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiGetBlob, apiPost, ApiError } from "@/lib/api"

interface Retired { invoiceNumber: string; pdfPath: string | null; foundAt: string }

export function LostInvoicesNotice({ onRestored }: { onRestored?: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const router = useRouter()
  const [rows, setRows] = useState<Retired[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    apiGet<Retired[]>(`/api/v1/invoices/retired-numbers?companyId=${companyId}`)
      .then((r) => setRows(Array.isArray(r) ? r : []))
      .catch(() => setRows([]))
  }, [])
  useEffect(load, [load])

  if (!rows.length) return null
  const companyId = typeof window !== "undefined" ? localStorage.getItem("companyId") : null
  const path = (n: string, what: string) => `/api/v1/invoices/retired-numbers/${encodeURIComponent(n)}/${what}?companyId=${companyId}`

  const openCopy = async (n: string) => {
    try {
      const { blob } = await apiGetBlob(path(n, "copy"))
      window.open(URL.createObjectURL(blob), "_blank", "noopener")
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e))
    }
  }
  const restore = async (n: string) => {
    setBusy(n)
    try {
      const r = await apiPost<{ id: string; customerCreated: boolean }>(path(n, "restore"), {})
      toast.success(t(r.customerCreated ? "invoice.lostRestoredNewCustomer" : "invoice.lostRestored", { number: n }))
      load()
      onRestored?.()
      router.push(`/dashboard/invoices/${r.id}`)
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e), 12000)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-lg border border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100 p-4 mb-4 space-y-2" data-testid="lost-invoices">
      <h2 className="font-semibold">{t("invoice.lostTitle", { n: rows.length })}</h2>
      <p className="text-sm">{t("invoice.lostHint")}</p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.invoiceNumber} className="flex flex-wrap items-center gap-2" data-testid="lost-invoice">
            <span className="font-mono">{r.invoiceNumber}</span>
            <Button size="sm" variant="outline" onClick={() => openCopy(r.invoiceNumber)} data-testid="lost-invoice-copy">
              {t("invoice.lostOpenCopy")}
            </Button>
            <Button size="sm" onClick={() => restore(r.invoiceNumber)} disabled={busy !== null} data-testid="lost-invoice-restore">
              {busy === r.invoiceNumber ? t("invoice.lostRestoring") : t("invoice.lostRestore")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
