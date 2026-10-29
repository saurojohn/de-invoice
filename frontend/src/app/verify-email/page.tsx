"use client"

/**
 * Tier 736 — the link from the confirmation mail. Public: it may be opened in
 * another browser than the one signed in. The token is sent once; the page
 * says whether the address is confirmed now.
 */
import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"

import { API_BASE } from "@/lib/api"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"

function VerifyEmailInner() {
  const token = useSearchParams().get("token") || ""
  const { t } = useI18n()
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null)
  const sent = useRef(false)

  useEffect(() => {
    if (sent.current) return
    sent.current = true
    if (!token) {
      setState({ ok: false, message: t("auth.verifyEmail.noToken") })
      return
    }
    // Pre-auth: raw fetch (apiFetch would add the headers of whoever is signed in)
    fetch(`${API_BASE}/api/v1/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        setState(res.ok
          ? { ok: true, message: t("auth.verifyEmail.done", { email: data?.email ?? "" }) }
          : { ok: false, message: data?.message || t("auth.verifyEmail.invalid") })
      })
      .catch(() => setState({ ok: false, message: t("auth.networkError") }))
    // t() changes identity with the locale; the token is sent once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-2xl">{t("auth.verifyEmail.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!state && <p className="text-sm text-gray-600 dark:text-gray-300">{t("auth.verifyEmail.checking")}</p>}
          {state && (
            <div
              data-testid="verify-email-result"
              role={state.ok ? "status" : "alert"}
              className={state.ok
                ? "bg-green-50 text-green-800 border border-green-200 p-3 rounded text-sm dark:bg-green-900/30 dark:text-green-200 dark:border-green-800"
                : "bg-red-100 text-red-700 p-3 rounded text-sm dark:bg-red-900/30 dark:text-red-200"}
            >
              {state.message}
            </div>
          )}
          <p className="text-center text-sm">
            <Link href="/dashboard" className="text-blue-600 hover:underline dark:text-blue-400">
              {t("auth.verifyEmail.toDashboard")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  )
}
