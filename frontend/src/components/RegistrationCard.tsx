"use client"

/**
 * Tier 820 — the operator opens or closes the public registration. Shown to
 * the installation's operator only (GET /auth/me `operator`); everyone else
 * invites people below.
 * Tier 821 — and invites someone to register a company of their own (one
 * company, for that address, within seven days): the link is mailed and shown
 * here once, to pass on when the mail does not go out.
 */
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { L, useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "@/lib/api"

interface CompanyInvite {
  id: string
  email: string
  createdAt: string
  expiresAt: string
  status: "pending" | "used" | "expired" | "revoked"
}

const day = (iso: string) => new Date(iso).toLocaleDateString("de-DE")

export default function RegistrationCard() {
  const { t } = useI18n()
  const toast = useToast()
  const [operator, setOperator] = useState(false)
  const [open, setOpen] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [invites, setInvites] = useState<CompanyInvite[]>([])
  const [email, setEmail] = useState("")
  const [created, setCreated] = useState<{ email: string; link: string; mailed: boolean } | null>(null)

  const loadInvites = useCallback(() => {
    apiGet<CompanyInvite[]>("/api/v1/auth/registration/invites").then(setInvites).catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    apiGet<{ operator?: boolean }>("/api/v1/auth/me")
      .then((me) => {
        if (!alive || !me?.operator) return
        setOperator(true)
        loadInvites()
        return apiGet<{ open: boolean }>("/api/v1/auth/registration").then((r) => { if (alive) setOpen(r.open) })
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [loadInvites])

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

  const invite = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await apiPost<{ email: string; link: string; mailed: boolean }>("/api/v1/auth/registration/invites", { email })
      setCreated(r)
      setEmail("")
      loadInvites()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("common.error"))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    setBusy(true)
    try {
      await apiDelete(`/api/v1/auth/registration/invites/${id}`)
      loadInvites()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("common.error"))
    } finally {
      setBusy(false)
    }
  }

  // Tier 824: without a clipboard (a page not served over HTTPS) this threw
  // a TypeError and nothing happened; the link stays on the card to select
  const copyLink = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.link)
      toast.success(t("users.companyInviteCopied"))
    } catch {
      toast.error(L("Kopieren nicht möglich — bitte den Link markieren und kopieren."))
    }
  }

  const statusText: Record<CompanyInvite["status"], string> = {
    pending: t("users.companyInvitePending"),
    used: t("users.companyInviteUsed"),
    expired: t("users.companyInviteExpired"),
    revoked: t("users.companyInviteRevoked"),
  }

  return (
    <Card className="mb-6" data-testid="registration-card">
      <CardHeader>
        <CardTitle>{t("users.registrationTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <p className="text-sm" data-testid="registration-state">
            {open ? t("users.registrationIsOpen") : t("users.registrationIsClosed")}
          </p>
          <Button variant={open ? "default" : "outline"} size="sm" disabled={busy} onClick={toggle} data-testid="registration-toggle">
            {open ? t("users.registrationClose") : t("users.registrationOpen")}
          </Button>
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-3">
          <h3 className="font-medium">{t("users.companyInviteTitle")}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t("users.companyInviteHint")}</p>
          <form onSubmit={invite} className="flex flex-wrap gap-2">
            <Input
              type="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              aria-label={t("auth.email")}
              className="flex-1 min-w-[12rem]"
              data-testid="company-invite-email"
            />
            <Button type="submit" size="sm" disabled={busy || !email.trim()} data-testid="company-invite-send">
              {t("users.companyInviteSend")}
            </Button>
          </form>
          {created && (
            <div className="bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded p-3 text-sm space-y-2" data-testid="company-invite-created">
              <p>{created.mailed ? t("users.companyInviteMailed") : t("users.companyInviteNotMailed")}</p>
              <div className="flex flex-wrap gap-2 items-center">
                <code className="text-xs break-all flex-1 min-w-0" data-testid="company-invite-link">{created.link}</code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={copyLink}
                >
                  {t("users.companyInviteCopy")}
                </Button>
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <ul className="text-sm divide-y divide-gray-100 dark:divide-gray-800" data-testid="company-invite-list">
              {invites.map((i) => (
                <li key={i.id} className="py-2 flex flex-wrap items-center gap-2">
                  <span className="flex-1 min-w-0 break-all">{i.email}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {statusText[i.status]}{i.status === "pending" ? ` · ${t("users.companyInviteUntil")} ${day(i.expiresAt)}` : ""}
                  </span>
                  {i.status === "pending" && (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => revoke(i.id)}>
                      {t("users.companyInviteRevoke")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Tier 822 — on the user page, the operator finds a link to „Systembetrieb“,
 * where the registration and the company invitations are now; nobody else
 * sees anything.
 */
export function OperatorPageLink() {
  const { t } = useI18n()
  const [operator, setOperator] = useState(false)
  useEffect(() => {
    let alive = true
    apiGet<{ operator?: boolean }>("/api/v1/auth/me")
      .then((me) => { if (alive) setOperator(me?.operator === true) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])
  if (!operator) return null
  return (
    <p className="mb-6 rounded border border-gray-200 dark:border-gray-700 p-3 text-sm" data-testid="operator-page-link">
      {t("users.operatorPageHint")}{" "}
      <Link href="/dashboard/operator" className="text-blue-600 dark:text-blue-400 hover:underline">{t("users.operatorPageLink")} →</Link>
    </p>
  )
}
