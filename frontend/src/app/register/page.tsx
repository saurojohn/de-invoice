"use client"

import { API_BASE } from "@/lib/api"

import { Suspense } from "react"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"

type Strength = { ok: boolean; msg: string }

function checkPasswordStrength(pw: string, t: (k: string) => string): Strength {
  if (pw.length < 8) return { ok: false, msg: t("auth.pwLength8") }
  if (!/[A-Za-z]/.test(pw)) return { ok: false, msg: t("auth.pwHasLetter") }
  if (!/[0-9]/.test(pw)) return { ok: false, msg: t("auth.pwHasNumber") }
  return { ok: true, msg: t("auth.pwOk") }
}

interface InvitationInfo {
  valid: boolean
  email?: string
  role?: string
  companyName?: string
  message?: string
}

function RegisterPageInner() {
  const router = useRouter()
  const search = useSearchParams()
  const inviteToken = search.get("invite") || ""
  const { t } = useI18n()
  const toast = useToast()

  // Self-service registration fields
  const [form, setForm] = useState({ email: "", password: "", companyName: "" })
  // Invitation-acceptance fields
  const [invPassword, setInvPassword] = useState("")
  const [invInfo, setInvInfo] = useState<InvitationInfo | null>(null)
  const [loadingInvite, setLoadingInvite] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const isInviteMode = !!inviteToken

  const isValidEmail = (email: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

  // Verify the invitation token on mount. Pre-auth page, so
  // raw fetch() is correct here (apiFetch injects x-user-id/
  // x-company-id headers we don't have yet).
  useEffect(() => {
    if (!inviteToken) return
    setLoadingInvite(true)
    fetch(`${API_BASE}/api/v1/invitations/verify?token=${encodeURIComponent(inviteToken)}`)
      .then((r) => r.json())
      .then((data) => {
        setInvInfo(data)
      })
      .catch(() => {
        setInvInfo({ valid: false, message: t("auth.connectionError") })
      })
      .finally(() => setLoadingInvite(false))
    // t() identity changes on locale switch, but the only
    // consumer here is the .catch fallback, so we can leave
    // it out of deps safely (linter would complain, so we
    // intentionally skip the include to keep behavior).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteToken])

  const pwCheck = checkPasswordStrength(
    isInviteMode ? invPassword : form.password,
    t,
  )

  const handleSubmitSelf = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (!isValidEmail(form.email)) {
      setError(t("auth.invalidEmail"))
      return
    }
    if (!pwCheck.ok) {
      setError(t("auth.passwordTooWeak", { msg: pwCheck.msg }))
      return
    }
    if (form.companyName.trim().length < 2) {
      setError(t("auth.companyNameRequired"))
      return
    }

    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim().toLowerCase(),
          password: form.password,
          companyName: form.companyName.trim(),
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        const msg =
          data.message === "Email already exists"
            ? t("auth.emailTaken") || t("auth.registerFailed")
            : t("auth.registerFailed")
        throw new Error(msg)
      }
      const data = await res.json()
      localStorage.setItem("companyId", data.company.id)
      localStorage.setItem("userId", data.user.id)
      localStorage.setItem("userEmail", data.user.email || "")
      toast.success(t("auth.registerSuccess"))
      router.push("/dashboard")
    } catch (err: any) {
      setError(err.message)
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmitInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (!pwCheck.ok) {
      setError(t("auth.passwordTooWeak", { msg: pwCheck.msg }))
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/v1/invitations/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: inviteToken, password: invPassword }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.message || t("auth.inviteAcceptError"))
      }
      const data = await res.json()
      // Auto-login: set localStorage and redirect
      localStorage.setItem("companyId", data.companyId)
      localStorage.setItem("userId", data.userId)
      localStorage.setItem("userEmail", data.email)
      router.push("/dashboard")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ================== Invitation mode UI ==================
  if (isInviteMode) {
    if (loadingInvite) {
      return (
        <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
          <p className="text-gray-500 dark:text-gray-400">{t("auth.verifyingInvite")}</p>
        </main>
      )
    }

    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center text-2xl">{t("auth.acceptInvite")}</CardTitle>
          </CardHeader>
          <CardContent>
            {invInfo?.valid ? (
              <form onSubmit={handleSubmitInvite} className="space-y-4" autoComplete="on">
                <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-900">
                  {t("auth.inviteFor", { company: invInfo.companyName || "" } as any)}
                  <br />
                  {t("auth.email")}: <strong>{invInfo.email}</strong>
                  <br />
                  {t("auth.inviteRole")}: <strong>{invInfo.role}</strong>
                </div>

                {error && (
                  <div className="bg-red-100 text-red-700 p-3 rounded text-sm" role="alert">
                    {error}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium mb-1" htmlFor="invPassword">
                    {t("auth.setPassword")}
                  </label>
                  <Input
                    id="invPassword"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    maxLength={128}
                    value={invPassword}
                    onChange={(e) => setInvPassword(e.target.value)}
                    placeholder={t("auth.invitePasswordPlaceholder")}
                    required
                    disabled={loading}
                  />
                  {invPassword.length > 0 && (
                    <p
                      className={`text-xs mt-1 ${
                        pwCheck.ok ? "text-green-600" : "text-orange-600"
                      }`}
                    >
                      {pwCheck.ok ? "✓ " : "⚠ "}
                      {pwCheck.msg}
                    </p>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={loading || !pwCheck.ok}>
                  {loading ? t("auth.inviteSaving") : t("auth.acceptInvite")}
                </Button>
                <p className="text-center text-sm">
                  <a href="/login" className="text-blue-600 hover:underline">
                    ← {t("auth.backToLogin")}
                  </a>
                </p>
              </form>
            ) : (
              <div className="space-y-3">
                <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
                  {invInfo?.message || t("auth.inviteInvalid")}
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  {t("auth.inviteRequestNew")}
                </p>
                <a
                  href="/login"
                  className="block text-center text-sm text-blue-600 hover:underline"
                >
                  ← {t("auth.backToLogin")}
                </a>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    )
  }

  // ================== Self-service registration UI ==================
  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-2xl">{t("auth.registerAccount")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmitSelf} className="space-y-4" autoComplete="on">
            {error && (
              <div className="bg-red-100 text-red-700 p-3 rounded text-sm" role="alert">
                {error}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="companyName">
                {t("auth.companyName")}
              </label>
              <Input
                id="companyName"
                name="companyName"
                autoComplete="organization"
                maxLength={200}
                value={form.companyName}
                onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                placeholder={t("auth.companyNamePlaceholder") || "ABC GmbH"}
                required
              />
            </div>
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
                autoComplete="new-password"
                maxLength={128}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={t("auth.invitePasswordPlaceholder")}
                required
              />
              {form.password.length > 0 && (
                <p
                  className={`text-xs mt-1 ${pwCheck.ok ? "text-green-600" : "text-orange-600"}`}
                >
                  {pwCheck.ok ? "✓ " : "⚠ "}
                  {pwCheck.msg}
                </p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t("auth.registering") : t("auth.createAccount")}
            </Button>
            <p className="text-center text-sm">
              {t("auth.haveAccount")}{" "}
              <a href="/login" className="text-blue-600 hover:underline">
                {t("auth.login")}
              </a>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterPageInner />
    </Suspense>
  )
}
