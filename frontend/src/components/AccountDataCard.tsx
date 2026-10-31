"use client"

/**
 * Tier 737 / 738 — the signed-in person's own data, and the end of the account.
 *
 * „Meine Daten herunterladen": everything the installation keeps about the
 * person (Art. 15 / 20 DSGVO) as JSON. The company's business records are
 * the company's, exported by an admin through the GoBD export.
 *
 * „Konto löschen": the account is anonymised (the address, the name, the
 * password, the sessions go; what the person booked stays with the company,
 * as the law keeps it). A company in which the person is the last admin while
 * others remain cannot lose its admin — the check says which. A company in
 * which the person is the only member is closed with the account: nobody can
 * sign in to it any more, its records are kept until the end of the
 * retention period (§ 147 AO, § 257 HGB) and then deleted.
 */
import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { apiFetch, apiGet, apiGetBlob } from "@/lib/api"
import { signOut } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { todayIso } from "@/lib/today"

type DeletionCheck = {
  blockers: Array<{ companyId: string; companyName: string; reason: string }>
  closes: Array<{ companyId: string; companyName: string; retentionUntil: string }>
}

export function AccountDataCard() {
  const { t, getDateLocale } = useI18n()
  const router = useRouter()
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [check, setCheck] = useState<DeletionCheck | null>(null)
  const [password, setPassword] = useState("")
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const download = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const { blob } = await apiGetBlob("/api/v1/auth/my-data")
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `meine-daten-${todayIso()}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setExportError((e as Error)?.message || t("account.error"))
    } finally {
      setExporting(false)
    }
  }

  const startDeletion = async () => {
    setError(null)
    try {
      setCheck(await apiGet<DeletionCheck>("/api/v1/auth/delete-account/check"))
    } catch (e) {
      setError((e as Error)?.message || t("account.error"))
    }
  }

  const confirmDeletion = async () => {
    setBusy(true)
    setError(null)
    try {
      await apiFetch("/api/v1/auth/delete-account", {
        method: "POST",
        body: { password, closeCompanies: (check?.closes.length ?? 0) > 0 },
      })
      await signOut()
      router.push("/login")
    } catch (e) {
      setError((e as Error)?.message || t("account.error"))
      setBusy(false)
    }
  }

  const date = (iso: string) => new Date(iso).toLocaleDateString(getDateLocale(), { day: "2-digit", month: "2-digit", year: "numeric" })

  return (
    <Card data-testid="account-data-card">
      <CardHeader>
        <CardTitle>{t("account.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-2">
          <h3 className="font-medium text-gray-900 dark:text-gray-100">{t("account.exportTitle")}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t("account.exportText")}</p>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t("account.exportCompanyText")}{" "}
            <Link href="/dashboard/audit" className="text-blue-600 hover:underline dark:text-blue-400">
              {t("account.exportCompanyLink")}
            </Link>
          </p>
          <Button variant="outline" onClick={download} disabled={exporting} data-testid="account-export">
            {exporting ? t("account.exporting") : t("account.exportButton")}
          </Button>
          {exportError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{exportError}</p>}
        </section>

        <section className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
          <h3 className="font-medium text-red-700 dark:text-red-400">{t("account.deleteTitle")}</h3>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t("account.deleteText")}</p>
          {!check && (
            <Button variant="outline" onClick={startDeletion} data-testid="account-delete-start">
              {t("account.deleteStart")}
            </Button>
          )}
          {check && check.blockers.length > 0 && (
            <div role="alert" data-testid="account-delete-blockers" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
              <p>{t("account.blockersIntro")}</p>
              <ul className="mt-1 list-disc pl-5">
                {check.blockers.map((b) => (
                  <li key={b.companyId}>
                    {t(b.reason === "operator-company" ? "account.blockerOperator" : "account.blockerLastAdmin", { company: b.companyName })}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {check && check.blockers.length === 0 && (
            <div className="space-y-3" data-testid="account-delete-confirm">
              {check.closes.length > 0 && (
                <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-900/30 dark:text-red-100">
                  <p>{t("account.closesIntro")}</p>
                  <ul className="mt-1 list-disc pl-5">
                    {check.closes.map((c) => (
                      <li key={c.companyId} data-testid="account-delete-closes">
                        {t("account.closesCompany", { company: c.companyName, date: date(c.retentionUntil) })}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2">{t("account.closesExportFirst")}</p>
                </div>
              )}
              <label className="block text-sm">
                <span className="text-gray-700 dark:text-gray-300">{t("account.password")}</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="account-delete-password"
                  className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
                />
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} data-testid="account-delete-understood" className="mt-0.5 h-4 w-4" />
                <span>{t("account.understood")}</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={confirmDeletion}
                  disabled={busy || !password || !understood}
                  data-testid="account-delete-confirm-button"
                  className="bg-red-600 text-white hover:bg-red-700"
                >
                  {busy ? t("account.deleting") : t("account.deleteConfirm")}
                </Button>
                <Button variant="outline" onClick={() => { setCheck(null); setPassword(""); setUnderstood(false); setError(null) }}>
                  {t("account.cancel")}
                </Button>
              </div>
            </div>
          )}
          {error && <p role="alert" data-testid="account-delete-error" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </section>
      </CardContent>
    </Card>
  )
}
