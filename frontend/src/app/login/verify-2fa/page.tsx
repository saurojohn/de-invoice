"use client"

import { API_BASE } from "@/lib/api"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"

function Verify2FAInner() {
  const router = useRouter()
  const search = useSearchParams()
  const email = search.get("email") || ""
  const { t } = useI18n()
  const toast = useToast()
  const [code, setCode] = useState("")
  const [recoveryCode, setRecoveryCode] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    if (!email) {
      setError("E-Mail fehlt")
      return
    }
    if (!/^\d{6}$/.test(code) && !recoveryCode.trim()) {
      setError(t("auth.verify2faWrong"))
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/2fa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          code: code || undefined,
          recoveryCode: recoveryCode || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = data?.message || t("auth.verify2faWrong")
        setError(msg)
        toast.error(msg)
        return
      }
      // Same shape as /auth/login → set the headers the
      // dashboard uses for auth.
      localStorage.setItem("userId", data.id)
      localStorage.setItem("userEmail", data.email || email)
      localStorage.setItem("companyId", data.companyId)
      localStorage.removeItem("pending2faEmail")
      router.push("/dashboard")
    } catch (err: any) {
      const msg = err?.message || t("auth.networkError")
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
          <CardTitle className="text-center text-2xl">
            {t("auth.verify2faTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {t("auth.verify2faIntro")}
            </p>
            {error && (
              <div
                className="bg-red-100 text-red-700 p-3 rounded text-sm"
                role="alert"
              >
                {error}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="code">
                {t("auth.code")}
              </label>
              <Input
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, ""))
                }
                placeholder="123456"
                autoFocus
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
              {t("auth.verify2faUseRecovery")}
            </p>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="recovery">
                {t("auth.recoveryCodePlaceholder") || "Recovery-Code"}
              </label>
              <Input
                id="recovery"
                name="recoveryCode"
                type="text"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                placeholder="XXXX-XXXX-XX"
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={loading || (!code && !recoveryCode.trim())}
            >
              {loading ? "..." : t("auth.verify2faSubmit")}
            </Button>
            <p className="text-center text-sm">
              <Link href="/login" className="text-blue-600 hover:underline">
                {t("auth.verify2faBack")}
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

// Next.js 14 requires useSearchParams to be wrapped in
// Suspense (it triggers a CSR bailout otherwise).
export default function Verify2FAPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center">…</div>}>
      <Verify2FAInner />
    </Suspense>
  )
}
