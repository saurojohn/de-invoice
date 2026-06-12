"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"

function checkPasswordStrength(pw: string): { ok: boolean; msg: string } {
  if (pw.length < 8) return { ok: false, msg: "至少 8 个字符" }
  if (!/[A-Za-z]/.test(pw)) return { ok: false, msg: "至少包含 1 个字母" }
  if (!/[0-9]/.test(pw)) return { ok: false, msg: "至少包含 1 个数字" }
  return { ok: true, msg: "密码强度符合要求" }
}

interface InvitationInfo {
  valid: boolean
  email?: string
  role?: string
  companyName?: string
  message?: string
}

export default function RegisterPage() {
  const router = useRouter()
  const search = useSearchParams()
  const inviteToken = search.get("invite") || ""

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

  // Verify the invitation token on mount
  useEffect(() => {
    if (!inviteToken) return
    setLoadingInvite(true)
    fetch(`http://localhost:3001/api/v1/invitations/verify?token=${encodeURIComponent(inviteToken)}`)
      .then((r) => r.json())
      .then((data) => {
        setInvInfo(data)
        if (data.valid && data.email) {
          setInvPassword("")
        }
      })
      .catch(() => {
        setInvInfo({ valid: false, message: "Verbindungsfehler" })
      })
      .finally(() => setLoadingInvite(false))
  }, [inviteToken])

  const pwCheck = checkPasswordStrength(isInviteMode ? invPassword : form.password)

  const handleSubmitSelf = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (!isValidEmail(form.email)) {
      setError("请输入有效的邮箱地址")
      return
    }
    if (!pwCheck.ok) {
      setError("密码强度不足：" + pwCheck.msg)
      return
    }
    if (form.companyName.trim().length < 2) {
      setError("请输入公司名称（至少 2 个字符）")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("http://localhost:3001/api/v1/auth/register", {
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
        throw new Error(data.message || "注册失败")
      }
      const data = await res.json()
      localStorage.setItem("companyId", data.company.id)
      localStorage.setItem("userId", data.user.id)
      localStorage.setItem("userEmail", data.user.email || "")
      router.push("/dashboard")
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmitInvite = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (!pwCheck.ok) {
      setError("密码强度不足：" + pwCheck.msg)
      return
    }
    setLoading(true)
    try {
      const res = await fetch("http://localhost:3001/api/v1/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: inviteToken, password: invPassword }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.message || "Fehler beim Annehmen der Einladung")
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
          <p className="text-gray-500 dark:text-gray-400">Einladung wird überprüft…</p>
        </main>
      )
    }

    return (
      <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-center text-2xl">Einladung annehmen</CardTitle>
          </CardHeader>
          <CardContent>
            {invInfo?.valid ? (
              <form onSubmit={handleSubmitInvite} className="space-y-4" autoComplete="on">
                <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-900">
                  Sie wurden eingeladen, dem Team{" "}
                  <strong>{invInfo.companyName}</strong> beizutreten.
                  <br />
                  E-Mail: <strong>{invInfo.email}</strong>
                  <br />
                  Rolle: <strong>{invInfo.role}</strong>
                </div>

                {error && (
                  <div className="bg-red-100 text-red-700 p-3 rounded text-sm" role="alert">
                    {error}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium mb-1" htmlFor="invPassword">
                    Passwort festlegen
                  </label>
                  <Input
                    id="invPassword"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    maxLength={128}
                    value={invPassword}
                    onChange={(e) => setInvPassword(e.target.value)}
                    placeholder="Mindestens 8 Zeichen, mit Buchstaben und Zahlen"
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
                  {loading ? "Wird gespeichert…" : "Einladung annehmen"}
                </Button>
                <p className="text-center text-sm">
                  <a href="/login" className="text-blue-600 hover:underline">
                    ← Zurück zur Anmeldung
                  </a>
                </p>
              </form>
            ) : (
              <div className="space-y-3">
                <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
                  {invInfo?.message || "Einladung ungültig oder abgelaufen."}
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Bitte fordern Sie eine neue Einladung vom Administrator Ihres Unternehmens an.
                </p>
                <a
                  href="/login"
                  className="block text-center text-sm text-blue-600 hover:underline"
                >
                  ← Zurück zur Anmeldung
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
          <CardTitle className="text-center text-2xl">注册账户</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmitSelf} className="space-y-4" autoComplete="on">
            {error && (
              <div className="bg-red-100 text-red-700 p-3 rounded text-sm" role="alert">
                {error}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="companyName">公司名称</label>
              <Input
                id="companyName"
                name="companyName"
                autoComplete="organization"
                maxLength={200}
                value={form.companyName}
                onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                placeholder="例如：ABC GmbH"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="email">邮箱</label>
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
              <label className="block text-sm font-medium mb-1" htmlFor="password">密码</label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                maxLength={128}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="至少 8 字符 + 1 字母 + 1 数字"
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
              {loading ? "注册中..." : "注册"}
            </Button>
            <p className="text-center text-sm">
              已有账户？{" "}
              <a href="/login" className="text-blue-600 hover:underline">
                登录
              </a>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
