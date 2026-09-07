"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"

export default function ForgotPasswordPage() {
  const { t } = useI18n()
  const toast = useToast()
  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setMessage(null)

    if (!isValidEmail(email)) {
      setError(t("auth.invalidEmail"))
      return
    }

    setLoading(true)
    try {
      // Pre-auth: no x-user-id/company-id yet, so raw fetch
      // is correct here (apiFetch would inject empty headers).
      const res = await fetch("http://localhost:3001/api/v1/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      })
      const data = await res.json().catch(() => ({}))
      // Backend returns the same generic message regardless of
      // whether the email is registered — that's deliberate
      // (don't leak which accounts exist). Use it as-is.
      const msg = data?.message || t("auth.forgotEmailSent")
      setMessage(msg)
      toast.success(msg)
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
          <CardTitle className="text-center text-2xl">{t("auth.forgotTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {t("auth.forgotIntro")}
            </p>

            {message && (
              <div
                className="bg-green-50 text-green-800 border border-green-200 p-3 rounded text-sm"
                role="status"
              >
                {message}
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
              <label className="block text-sm font-medium mb-1" htmlFor="email">
                {t("auth.email")}
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@example.com"
                required
                disabled={loading}
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t("auth.forgotSending") : t("auth.forgotRequest")}
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
