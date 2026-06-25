"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"

const MAX_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000 // 15 min

export default function LoginPage() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  const [form, setForm] = useState({ email: "", password: "" })
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null)
  const [attemptCount, setAttemptCount] = useState(0)

  const isValidEmail = (email: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")

    if (lockoutUntil && Date.now() < lockoutUntil) {
      const mins = Math.ceil((lockoutUntil - Date.now()) / 60000)
      setError(
        t("auth.tooManyAttempts", { minutes: String(mins) }) ||
          `Zu viele fehlgeschlagene Versuche. Bitte warten Sie ${mins} Minuten.`,
      )
      return
    }

    if (!isValidEmail(form.email)) {
      setError(t("auth.invalidEmail"))
      return
    }
    if (form.password.length < 1) {
      setError(t("auth.passwordRequired") || "Bitte geben Sie Ihr Passwort ein")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("http://localhost:3001/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim().toLowerCase(),
          password: form.password,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        // Map known backend errors to i18n keys where
        // we can; otherwise fall back to a translated
        // generic "login failed" so the user never
        // sees English/Chinese raw messages.
        const msg =
          data.message === "Invalid credentials"
            ? t("auth.invalidCredentials") || t("auth.loginFailed")
            : t("auth.loginFailed")
        const next = attemptCount + 1
        setAttemptCount(next)
        if (next >= MAX_ATTEMPTS) {
          setLockoutUntil(Date.now() + LOCKOUT_DURATION_MS)
        }
        setError(msg)
        return
      }

      const data = await res.json()
      // 2FA gate: if the password was right but 2FA is
      // on, the server returned twoFactorRequired:true
      // instead of { id, email, companyId }. Stash the
      // email so /verify-2fa can re-use it without the
      // user re-typing, and route to the 2FA page.
      if (data?.twoFactorRequired) {
        localStorage.setItem("pending2faEmail", data.email || form.email.toLowerCase())
        router.push(`/login/verify-2fa?email=${encodeURIComponent(data.email || form.email)}`)
        return
      }
      localStorage.setItem("userId", data.id)
      localStorage.setItem("userEmail", data.email || "")
      localStorage.setItem("companyId", data.companyId)
      // Tier 12: mirror the auth tokens
      // into cookies so the Next.js
      // middleware (which can't see
      // localStorage) lets the user
      // into /dashboard. The
      // AuthCookieSync effect also
      // writes these, but it runs
      // AFTER mount — by then the
      // middleware has already
      // redirected to /login. We set
      // the cookies inline here so the
      // very next navigation is
      // accepted.
      const oneDay = 60 * 60 * 24
      document.cookie = `x-user-id=${encodeURIComponent(data.id)}; path=/; max-age=${oneDay}; SameSite=Lax`
      document.cookie = `x-company-id=${encodeURIComponent(data.companyId)}; path=/; max-age=${oneDay}; SameSite=Lax`
      setAttemptCount(0)
      setLockoutUntil(null)
      router.push("/dashboard")
    } catch (err: any) {
      const msg = t("auth.networkError") || "Netzwerkfehler"
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  const remainingLockout = lockoutUntil ? Math.max(0, lockoutUntil - Date.now()) : 0
  const isLockedOut = remainingLockout > 0

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-2xl">{t("auth.loginTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" autoComplete="on">
            {error && (
              <div className="bg-red-100 text-red-700 p-3 rounded text-sm" role="alert">
                {error}
              </div>
            )}
            {isLockedOut && (
              <div className="bg-orange-100 text-orange-800 p-3 rounded text-sm" role="alert">
                {t("auth.locked", { minutes: String(Math.ceil(remainingLockout / 60000)) }) ||
                  `Konto vorübergehend gesperrt. Bitte versuchen Sie es in ${Math.ceil(remainingLockout / 60000)} Minuten erneut.`}
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
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="email@example.com"
                required
                disabled={isLockedOut}
                aria-invalid={!!error}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="password">
                {t("auth.password")}
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                maxLength={128}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="••••••••"
                required
                disabled={isLockedOut}
                aria-invalid={!!error}
              />
              <div className="text-right mt-1">
                <a
                  href="/forgot-password"
                  className="text-xs text-blue-600 hover:underline"
                >
                  {t("auth.forgotPassword")}
                </a>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={loading || isLockedOut}>
              {loading
                ? t("common.loading") || "..."
                : isLockedOut
                  ? t("auth.lockedShort") || "Gesperrt"
                  : t("auth.login")}
            </Button>
            {attemptCount > 0 && !isLockedOut && (
              <p className="text-center text-xs text-gray-500 dark:text-gray-400">
                {t("auth.attemptsLeft", { count: String(MAX_ATTEMPTS - attemptCount) }) ||
                  `${MAX_ATTEMPTS - attemptCount} verbleibende Versuche`}
              </p>
            )}
            <p className="text-center text-sm">
              {t("auth.noAccount")}{" "}
              <a href="/register" className="text-blue-600 hover:underline">
                {t("auth.register")}
              </a>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
