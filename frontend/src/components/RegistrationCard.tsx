"use client"

/**
 * Tier 820 — the operator opens or closes the public registration. Shown to
 * the installation's operator only (GET /auth/me `operator`); everyone else
 * invites people below.
 */
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPut, ApiError } from "@/lib/api"

export default function RegistrationCard() {
  const { t } = useI18n()
  const toast = useToast()
  const [operator, setOperator] = useState(false)
  const [open, setOpen] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    apiGet<{ operator?: boolean }>("/api/v1/auth/me")
      .then((me) => {
        if (!alive || !me?.operator) return
        setOperator(true)
        return apiGet<{ open: boolean }>("/api/v1/auth/registration").then((r) => { if (alive) setOpen(r.open) })
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  if (!operator || open === null) return null

  const toggle = async () => {
    setBusy(true)
    try {
      const r = await apiPut<{ open: boolean }>("/api/v1/auth/registration", { open: !open })
      setOpen(r.open)
      toast.success(r.open ? t("users.registrationOpened") : t("users.registrationClosed"))
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("common.error"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-6" data-testid="registration-card">
      <CardHeader>
        <CardTitle>{t("users.registrationTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm" data-testid="registration-state">
          {open ? t("users.registrationIsOpen") : t("users.registrationIsClosed")}
        </p>
        <Button variant={open ? "default" : "outline"} size="sm" disabled={busy} onClick={toggle} data-testid="registration-toggle">
          {open ? t("users.registrationClose") : t("users.registrationOpen")}
        </Button>
      </CardContent>
    </Card>
  )
}
