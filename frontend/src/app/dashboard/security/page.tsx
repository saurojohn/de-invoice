"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPost, ApiError } from "@/lib/api"

interface TwoFactorStatus {
  enabled: boolean
  remainingRecoveryCodes: number
}

interface TwoFactorSetup {
  secret: string
  qrCodeDataUrl: string
  otpauthUrl: string
}

interface EnableResponse {
  ok: boolean
  enabled: boolean
  recoveryCodes: string[]
}

export default function TwoFactorPage() {
  const router = useRouter()
  const { t } = useI18n()
  const toast = useToast()
  const [status, setStatus] = useState<TwoFactorStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null)
  const [code, setCode] = useState("")
  const [recoveryCode, setRecoveryCode] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiPost<TwoFactorStatus>("/api/v1/auth/2fa/status", {})
      setStatus(data)
    } catch (e: any) {
      toast.error(e?.message ?? t("common.loadError"))
    } finally {
      setLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    load()
  }, [load, router])

  const startSetup = async () => {
    setSubmitting(true)
    try {
      const data = await apiPost<TwoFactorSetup>("/api/v1/auth/2fa/setup", {})
      setSetup(data)
      setCode("")
      setRecoveryCodes(null)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : t("twoFactor.setupFailed")
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const verifyAndEnable = async () => {
    if (!/^\d{6}$/.test(code)) {
      toast.error(t("twoFactor.invalidCode"))
      return
    }
    setSubmitting(true)
    try {
      const data = await apiPost<EnableResponse>("/api/v1/auth/2fa/enable", {
        code,
      })
      setRecoveryCodes(data.recoveryCodes)
      setSetup(null)
      setCode("")
      await load()
      toast.success(t("twoFactor.enabled"))
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : t("twoFactor.invalidCode")
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const copyCode = (c: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(c).then(
        () => toast.success(t("twoFactor.codeCopied")),
        () => {},
      )
    }
  }

  const disable = async () => {
    setSubmitting(true)
    try {
      await apiPost("/api/v1/auth/2fa/disable", {
        code: code || undefined,
        recoveryCode: recoveryCode || undefined,
      })
      setConfirming(false)
      setCode("")
      setRecoveryCode("")
      await load()
      toast.success(t("twoFactor.disabled"))
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : t("twoFactor.invalidCode")
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4 sm:p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {t("twoFactor.title")}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t("twoFactor.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="text-sm text-blue-600 hover:underline"
            >
              ← {t("nav.dashboard")}
            </Link>
            <LanguageSwitcher />
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("common.loading")}
          </p>
        ) : status?.enabled ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-emerald-600 dark:text-emerald-400">
                ✓ {t("twoFactor.statusEnabled")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {t("twoFactor.remainingCodes", {
                  n: String(status.remainingRecoveryCodes),
                })}
              </p>
              {!confirming ? (
                <Button
                  variant="outline"
                  onClick={() => setConfirming(true)}
                  disabled={submitting}
                >
                  {t("twoFactor.disable")}
                </Button>
              ) : (
                <div className="space-y-3 border-t pt-4">
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {t("twoFactor.enterCodeToDisable")}
                  </p>
                  <Input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, ""))
                    }
                    placeholder={t("twoFactor.codePlaceholder")}
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t("twoFactor.useRecoveryCode")}
                  </p>
                  <Input
                    type="text"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    placeholder={t("twoFactor.recoveryCodePlaceholder")}
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      onClick={disable}
                      disabled={submitting || (!code && !recoveryCode)}
                    >
                      {t("twoFactor.disable")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setConfirming(false)
                        setCode("")
                        setRecoveryCode("")
                      }}
                    >
                      {t("common.cancel") || "Abbrechen"}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ) : setup ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("twoFactor.setup")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {t("twoFactor.scanQR")}
              </p>
              <div className="flex justify-center bg-white p-4 rounded">
                <img
                  src={setup.qrCodeDataUrl}
                  alt="2FA QR"
                  className="w-48 h-48"
                />
              </div>
              <details className="text-xs text-gray-500">
                <summary className="cursor-pointer">
                  Manually enter secret
                </summary>
                <code className="block mt-1 p-2 bg-gray-100 dark:bg-gray-800 rounded break-all">
                  {setup.secret}
                </code>
              </details>
              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("twoFactor.code")}
                </label>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, ""))
                  }
                  placeholder={t("twoFactor.codePlaceholder")}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={verifyAndEnable}
                  disabled={submitting || code.length !== 6}
                >
                  {t("twoFactor.verifyEnable")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSetup(null)
                    setCode("")
                  }}
                >
                  {t("common.cancel") || "Abbrechen"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : recoveryCodes ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-emerald-600 dark:text-emerald-400">
                ✓ {t("twoFactor.enabled")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded p-3">
                {t("twoFactor.saveCodes")}
              </p>
              <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
                {recoveryCodes.map((c) => (
                  <li
                    key={c}
                    onClick={() => copyCode(c)}
                    className="cursor-pointer bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 px-3 py-2 rounded text-center"
                    title="Klicken zum Kopieren"
                  >
                    {c}
                  </li>
                ))}
              </ul>
              <Button onClick={() => setRecoveryCodes(null)} className="w-full">
                {t("common.continue") || "Verstanden"}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{t("twoFactor.statusDisabled")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
                {t("twoFactor.subtitle")}
              </p>
              <Button onClick={startSetup} disabled={submitting}>
                {t("twoFactor.setup")}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  )
}
