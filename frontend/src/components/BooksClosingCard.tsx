"use client"

/**
 * Tier 609 — closing the books (Festschreibung).
 *
 * Shows up to which day the books are closed, closes them up to a day, and
 * lifts the closing again (with a reason — the audit log keeps it). Up to
 * and including that day the backend refuses every new, changed or deleted
 * document and voucher.
 */
import { todayIso } from "@/lib/today"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { ApiError, apiGet, apiPut } from "@/lib/api"

const day = (iso: string) => iso.split("-").reverse().join(".")

export function BooksClosingCard() {
  const { t } = useI18n()
  const toast = useToast()
  const [closedUntil, setClosedUntil] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [date, setDate] = useState("")
  const [reason, setReason] = useState("")
  const [lifting, setLifting] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    try {
      const r = await apiGet<{ closedUntil: string | null }>(`/api/v1/accounting/books-closing?companyId=${companyId}`)
      setClosedUntil(r.closedUntil)
    } catch {
      // not allowed to see it: the card stays empty
    } finally {
      setLoaded(true)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const save = async (next: string | null) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setBusy(true)
    try {
      const r = await apiPut<{ closedUntil: string | null }>(`/api/v1/accounting/books-closing?companyId=${companyId}`, {
        closedUntil: next,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      setClosedUntil(r.closedUntil)
      setDate("")
      setReason("")
      setLifting(false)
      toast.success(r.closedUntil ? t("booksClosing.closedToast").replace("{date}", day(r.closedUntil)) : t("booksClosing.reopenedToast"))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("booksClosing.failed"))
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return null
  const input = "px-2 py-1.5 border rounded text-sm dark:bg-gray-900"
  // an earlier day than the current one lifts part of the closing: needs the reason too
  const earlier = !!closedUntil && !!date && date < closedUntil
  return (
    <Card className="mb-6" data-testid="books-closing-card">
      <CardHeader>
        <CardTitle className="text-base">🔒 {t("booksClosing.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-gray-600 dark:text-gray-300">{t("booksClosing.hint")}</p>
        <p className="font-medium" data-testid="books-closing-state">
          {closedUntil ? t("booksClosing.closedUntil").replace("{date}", day(closedUntil)) : t("booksClosing.open")}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1" htmlFor="books-closing-date">
              {t("booksClosing.dateLabel")}
            </label>
            <input id="books-closing-date" type="date" className={input} value={date} data-testid="books-closing-date"
              max={todayIso()} onChange={(e) => setDate(e.target.value)} />
          </div>
          {earlier && (
            <div className="flex-1 min-w-[12rem]">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1" htmlFor="books-closing-reason-inline">
                {t("booksClosing.reasonLabel")}
              </label>
              <input id="books-closing-reason-inline" className={`${input} w-full`} value={reason} data-testid="books-closing-reason"
                onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          <Button size="sm" disabled={busy || !date || date === closedUntil || (earlier && reason.trim().length < 5)}
            onClick={() => save(date)} data-testid="books-closing-save">
            {t("booksClosing.close")}
          </Button>
          {closedUntil && !lifting && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setLifting(true)} data-testid="books-closing-lift">
              {t("booksClosing.lift")}
            </Button>
          )}
        </div>
        {lifting && (
          <div className="rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-900/20" data-testid="books-closing-lift-form">
            <p className="mb-2 text-amber-900 dark:text-amber-200">{t("booksClosing.liftWarning")}</p>
            <label className="block text-xs font-medium mb-1" htmlFor="books-closing-reason">{t("booksClosing.reasonLabel")}</label>
            <input id="books-closing-reason" className={`${input} w-full`} value={reason} data-testid="books-closing-lift-reason"
              onChange={(e) => setReason(e.target.value)} />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || reason.trim().length < 5} onClick={() => save(null)} data-testid="books-closing-lift-confirm">
                {t("booksClosing.liftConfirm")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setLifting(false); setReason("") }}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
