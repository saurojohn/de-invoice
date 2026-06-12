"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"

const MAX_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000 // 15 min

export default function LoginPage() {
  const router = useRouter()
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
      setError(`Zu viele fehlgeschlagene Versuche. Bitte warten Sie ${mins} Minuten.`)
      return
    }

    if (!isValidEmail(form.email)) {
      setError("Bitte geben Sie eine gültige E-Mail-Adresse ein")
      return
    }
    if (form.password.length < 1) {
      setError("Bitte geben Sie Ihr Passwort ein")
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
        const msg = data.message || "登录失败"
        const next = attemptCount + 1
        setAttemptCount(next)
        if (next >= MAX_ATTEMPTS) {
          setLockoutUntil(Date.now() + LOCKOUT_DURATION_MS)
        }
        setError(msg)
        return
      }

      const data = await res.json()
      localStorage.setItem("userId", data.id)
      localStorage.setItem("userEmail", data.email || "")
      localStorage.setItem("companyId", data.companyId)
      setAttemptCount(0)
      setLockoutUntil(null)
      router.push("/dashboard")
    } catch (err: any) {
      setError(err?.message || "Netzwerkfehler")
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
          <CardTitle className="text-center text-2xl">登录</CardTitle>
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
                Konto vorübergehend gesperrt. Bitte versuchen Sie es in {Math.ceil(remainingLockout / 60000)} Minuten erneut.
              </div>
            )}
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
                disabled={isLockedOut}
                aria-invalid={!!error}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="password">密码</label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                maxLength={128}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="输入密码"
                required
                disabled={isLockedOut}
                aria-invalid={!!error}
              />
              <div className="text-right mt-1">
                <a
                  href="/forgot-password"
                  className="text-xs text-blue-600 hover:underline"
                >
                  Passwort vergessen?
                </a>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={loading || isLockedOut}>
              {loading ? "登录中..." : isLockedOut ? "Gesperrt" : "登录"}
            </Button>
            {attemptCount > 0 && !isLockedOut && (
              <p className="text-center text-xs text-gray-500 dark:text-gray-400">
                {MAX_ATTEMPTS - attemptCount} verbleibende Versuche
              </p>
            )}
            <p className="text-center text-sm">
              还没有账户？{" "}
              <a href="/register" className="text-blue-600 hover:underline">
                注册
              </a>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
