"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"

export default function ResetPasswordPage() {
  const router = useRouter()
  const search = useSearchParams()
  const token = search.get("token") || ""
  const { t } = useI18n()
  const toast = useToast()

  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setError(t("auth.resetNoToken"))
    }
    // t() identity changes on locale switch but the
    // error message is the same shape in all locales
    // for this branch, so leaving deps empty is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (password.length < 8) {
      const msg = t("auth.resetMinLength")
      setError(msg)
      toast.error(msg)
      return
    }
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      const msg = t("auth.resetNeedsLetterAndNumber")
      setError(msg)
      toast.error(msg)
      return
    }
    if (password !== confirm) {
      const msg = t("auth.passwordMismatch")
      setError(msg)
      toast.error(msg)
      return
    }

    setLoading(true)
    try {
      // Pre-auth: no x-user-id/company-id yet, so raw
      // fetch is correct here (apiFetch would inject
      // empty headers).
      const res = await fetch("http://localhost:3001/api/v1/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = data?.message || t("auth.resetInvalidToken")
        setError(msg)
        toast.error(msg)
        return
      }
      const msg = data?.message || t("auth.resetSuccess")
      setSuccess(msg)
      toast.success(msg)
      setTimeout(() => router.push("/login"), 2000)
    } catch {
      const msg = t("auth.networkError")
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-2xl">{t("auth.resetTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {t("auth.resetIntro")}
            </p>

            {success && (
              <div
                className="bg-green-50 text-green-800 border border-green-200 p-3 rounded text-sm"
                role="status"
              >
                {success}
              </div>
            )}
            {error && (
              <div
                className="bg-red-100 text-red-700 p-3 rounded text-sm"
                role="alert"
              >
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="password">
                {t("auth.resetNewPassword")}
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("auth.resetNewPasswordPlaceholder")}
                required
                disabled={loading || !token || !!success}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="confirm">
                {t("auth.resetConfirmPassword")}
              </label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                maxLength={128}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={t("auth.resetConfirmPlaceholder")}
                required
                disabled={loading || !token || !!success}
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !token || !!success}
            >
              {loading ? t("auth.resetSaving") : t("auth.resetSave")}
            </Button>

            <p className="text-center text-sm">
              <a href="/login" className="text-blue-600 hover:underline">
                ← {t("auth.backToLogin")}
              </a>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
