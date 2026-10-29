"use client"

/**
 * Tier 736 — the account's e-mail address is not confirmed yet.
 *
 * Until an admin of the company has confirmed their address, the
 * installation's mail server sends nothing for the company (invoices,
 * reminders, invitations). The notice says so and sends the link again.
 * Nothing is shown once the address is confirmed, or while /auth/me fails.
 */
import { useEffect, useState } from "react"

import { apiGet, apiPost } from "@/lib/api"
import { useI18n } from "@/components/useI18n"

export function EmailVerificationNotice() {
  const { t } = useI18n()
  const [email, setEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    apiGet<{ email?: string; emailVerified?: boolean }>("/api/v1/auth/me")
      .then((me) => { if (me && me.emailVerified === false) setEmail(me.email || "") })
      .catch(() => undefined)
  }, [])

  if (email === null) return null

  const resend = async () => {
    setBusy(true)
    setResult(null)
    try {
      const r = await apiPost<{ message?: string; alreadyVerified?: boolean }>("/api/v1/auth/resend-verification")
      if (r?.alreadyVerified) { setEmail(null); return }
      setResult({ ok: true, message: t("auth.verifyEmail.resent", { email }) })
    } catch (e) {
      setResult({ ok: false, message: (e as Error)?.message || t("auth.networkError") })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="status"
      data-testid="email-verification-notice"
      className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100"
    >
      <p>{t("auth.verifyEmail.notice", { email })}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="email-verification-resend"
          onClick={resend}
          disabled={busy}
          className="rounded border border-amber-400 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-600 dark:bg-gray-800 dark:text-amber-100 dark:hover:bg-gray-700"
        >
          {t("auth.verifyEmail.resend")}
        </button>
        {result && (
          <span data-testid="email-verification-result" className={result.ok ? "" : "text-red-700 dark:text-red-300"}>
            {result.message}
          </span>
        )}
      </div>
    </div>
  )
}
