"use client"

/**
 * Tier 575 — change the password while signed in (security page).
 *
 * Until now the only way to a new password was "Passwort vergessen": a mail
 * server and the mailbox. The current password is asked for again; the server
 * ends every other session and hands this browser a new one.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/components/useI18n"
import { apiPost } from "@/lib/api"

export function ChangePasswordCard() {
  const { t } = useI18n()
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState(false)

  const mismatch = repeat.length > 0 && next !== repeat
  const weak = next.length > 0 && (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next))
  const ready = !!current && !!next && next === repeat && !weak && !busy

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError("")
    setDone(false)
    try {
      await apiPost("/api/v1/auth/change-password", { currentPassword: current, newPassword: next })
      setCurrent("")
      setNext("")
      setRepeat("")
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-testid="change-password-card">
      <CardHeader>
        <CardTitle>{t("changePassword.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm">
            <span className="text-gray-700 dark:text-gray-300">{t("changePassword.current")}</span>
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} data-testid="change-password-current" />
          </label>
          <label className="block text-sm">
            <span className="text-gray-700 dark:text-gray-300">{t("changePassword.new")}</span>
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} data-testid="change-password-new" />
          </label>
          <p className={`text-xs ${weak ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}>{t("changePassword.rule")}</p>
          <label className="block text-sm">
            <span className="text-gray-700 dark:text-gray-300">{t("changePassword.repeat")}</span>
            <Input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} data-testid="change-password-repeat" />
          </label>
          {mismatch && <p className="text-xs text-red-600 dark:text-red-400" data-testid="change-password-mismatch">{t("changePassword.mismatch")}</p>}
          {error && (
            <div className="p-3 rounded border border-red-300 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200 text-sm" data-testid="change-password-error">
              {error}
            </div>
          )}
          {done && (
            <div className="p-3 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 text-sm" data-testid="change-password-done">
              {t("changePassword.done")}
            </div>
          )}
          <Button type="submit" disabled={!ready} data-testid="change-password-submit">
            {busy ? t("changePassword.saving") : t("changePassword.submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
