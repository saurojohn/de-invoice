"use client"

/**
 * Tier 794 — „Nächste Rechnungsnummer“: the number the company's next invoice
 * gets (GET/PUT /companies/:id/invoice-number). Only above the highest number
 * used; the backend refuses anything lower and says the lowest. Saved on its
 * own (it changes the range at once, not with the rest of the form).
 */
import { useCallback, useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPut, ApiError } from "@/lib/api"

interface NextNumber {
  invoiceNumber: string
  next: number
  minimum: number
  maximum: number
  year: number
  continuous: boolean
}

export default function NextInvoiceNumberField({ companyId, refreshKey }: { companyId: string | null; refreshKey: number }) {
  const { t } = useI18n()
  const [info, setInfo] = useState<NextNumber | null>(null)
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    try {
      const d = await apiGet<NextNumber>(`/api/v1/companies/${companyId}/invoice-number`)
      if (d && typeof d.next === "number") {
        setInfo(d)
        setValue(String(d.next))
      }
    } catch {
      setInfo(null)
    }
  }, [companyId])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const apply = async () => {
    if (!companyId || !info) return
    const raw = value.trim()
    const n = Number(raw)
    if (!/^[0-9]+$/.test(raw) || n < info.minimum || n > info.maximum) {
      setMsg({ ok: false, text: t("settings.nextInvoiceNumberInvalid", { minimum: info.minimum, maximum: info.maximum }) })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      const d = await apiPut<NextNumber>(`/api/v1/companies/${companyId}/invoice-number`, { next: n })
      setInfo(d)
      setValue(String(d.next))
      setMsg({ ok: true, text: t("settings.nextInvoiceNumberSaved", { number: d.invoiceNumber }) })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : t("settings.saveError") })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <label className="block text-sm font-medium mb-1" htmlFor="settings-next-invoice-number">
        {t("settings.nextInvoiceNumber")}
      </label>
      <div className="flex gap-2">
        <Input
          id="settings-next-invoice-number"
          inputMode="numeric"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setMsg(null)
          }}
          onKeyDown={(e) => {
            // its own save, not the settings form's submit
            if (e.key === "Enter") {
              e.preventDefault()
              apply()
            }
          }}
          disabled={!info}
          data-testid="settings-next-invoice-number"
        />
        <Button
          type="button"
          variant="outline"
          onClick={apply}
          disabled={!info || saving || value.trim() === String(info.next)}
          data-testid="settings-next-invoice-number-apply"
        >
          {t("settings.nextInvoiceNumberApply")}
        </Button>
      </div>
      {info && (
        <p className="mt-1 text-xs text-gray-500" data-testid="settings-next-invoice-number-hint">
          {t("settings.nextInvoiceNumberHint", { number: info.invoiceNumber, minimum: info.minimum })}
        </p>
      )}
      {msg && (
        <p
          className={`mt-1 text-xs ${msg.ok ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
          role={msg.ok ? "status" : "alert"}
          data-testid="settings-next-invoice-number-msg"
        >
          {msg.text}
        </p>
      )}
    </div>
  )
}
