"use client"

// Tier 37: Mahngebühren + Verzugszins settings.
//
// Per-company config in Company.bankInfo.mahnungConfig:
//   - verzugszinsPct: % per annum over Basiszinssatz (§288 Abs. 2 BGB)
//   - mahngebuehr.first | second | final: per-letter fee
//
// Defaults per §288 BGB (B2B).
// The backend's ReminderService clamps values to sane ranges
// (pct [0,50], fee [0,1000]) so the form can't accidentally
// set a fee of -50 or a 200% interest rate.

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { ThemeToggle } from "@/components/ThemeToggle"
import { useI18n } from "@/components/useI18n"
import { apiGet, apiPut } from "@/lib/api"
import { signOut } from "@/lib/auth"

interface FeeConfig {
  verzugszinsPct: number
  mahngebuehr: { first: number; second: number; final: number }
  isDefault: boolean
}

const DEFAULT_CFG: FeeConfig = {
  verzugszinsPct: 9,
  mahngebuehr: { first: 0, second: 2.5, final: 5 },
  isDefault: true,
}

export default function MahnungSettingsPage() {
  const router = useRouter()
  const { t } = useI18n()
  const [cfg, setCfg] = useState<FeeConfig>(DEFAULT_CFG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)

  useEffect(() => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      router.push("/login")
      return
    }
    setLoading(true)
    apiGet<FeeConfig>(
      `/api/v1/reminders/mahnungen/fees-config?companyId=${companyId}`,
    )
      .then((d) => {
        setCfg(d)
        setLoading(false)
      })
      .catch((err: any) => {
        setError(err?.message || "Unbekannter Fehler")
        setLoading(false)
      })
  }, [router])

  async function handleSave() {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setSaving(true)
    setSavedOk(false)
    try {
      const res = await apiPut<{ ok: boolean; config: FeeConfig }>(
        `/api/v1/reminders/mahnungen/fees-config?companyId=${companyId}`,
        {
          verzugszinsPct: cfg.verzugszinsPct,
          mahngebuehr: {
            first: cfg.mahngebuehr.first,
            second: cfg.mahngebuehr.second,
            final: cfg.mahngebuehr.final,
          },
        },
      )
      setCfg({ ...res.config, isDefault: false })
      setSavedOk(true)
      setTimeout(() => setSavedOk(false), 3000)
      setSaving(false)
    } catch (err: any) {
      setError(err?.message || "Speichern fehlgeschlagen")
      setSaving(false)
    }
  }

  function resetDefaults() {
    setCfg(DEFAULT_CFG)
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 border-b shadow-sm">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1
              className="text-2xl font-bold text-blue-600 dark:text-blue-400"
              data-testid="mahnung-settings-title"
            >
              ⚙ {t("mahnung.settings")}
            </h1>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/dashboard/mahnungen")}
              data-testid="mahnung-settings-back"
            >
              ← {t("mahnung.title")}
            </Button>
            {/* Tier 151: jump to the e-mail
                template editor. The settings page
                is for fees (mahngebuehr +
                verzugszins) — the templates page
                is for the e-mail subject + body
                of each Mahnung level. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push("/dashboard/mahnungen/templates")}
              data-testid="mahnung-settings-templates-link"
            >
              ✉ {t("mahnung.templatesLink")}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
            <Button
              variant="outline"
              onClick={async () => {
                // Tier 401: revoke the session server-side first — clearing
                // localStorage used to leave the credential valid.
                await signOut()
                router.push("/login")
              }}
            >
              {t("dashboard.logout")}
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-2xl">
        {loading && (
          <div
            className="text-center py-12 text-gray-500"
            data-testid="mahnung-settings-loading"
          >
            Lade Konfiguration…
          </div>
        )}
        {error && (
          <div
            className="p-4 bg-red-50 border border-red-200 text-red-800 rounded mb-4"
            data-testid="mahnung-settings-error"
          >
            ✗ {error}
          </div>
        )}
        {!loading && (
          <Card data-testid="mahnung-settings-card">
            <CardHeader>
              <CardTitle>{t("mahnung.feesSubtitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {/* Verzugszins */}
                <div>
                  <label
                    className="block text-sm font-medium mb-1"
                    htmlFor="verzugszinsPct-input"
                  >
                    {t("mahnung.verzugszinsPct")}
                  </label>
                  <input
                    id="verzugszinsPct-input"
                    type="number"
                    step="0.1"
                    min={0}
                    max={50}
                    value={cfg.verzugszinsPct}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        verzugszinsPct: Number(e.target.value) || 0,
                      })
                    }
                    className="w-32 px-3 py-2 border rounded dark:bg-gray-800 dark:border-gray-700"
                    data-testid="mahnung-verzugszins-input"
                  />
                  <span className="ml-2 text-xs text-gray-400">
                    (BGB §288 Abs. 2: 9 % Standard für B2B)
                  </span>
                </div>

                {/* Mahngebühr per stage */}
                <div className="space-y-3">
                  <div>
                    <label
                      className="block text-sm font-medium mb-1"
                      htmlFor="mahngebuehr-first-input"
                    >
                      {t("mahnung.firstStage")}
                    </label>
                    <input
                      id="mahngebuehr-first-input"
                      type="number"
                      step="0.1"
                      min={0}
                      max={1000}
                      value={cfg.mahngebuehr.first}
                      onChange={(e) =>
                        setCfg({
                          ...cfg,
                          mahngebuehr: {
                            ...cfg.mahngebuehr,
                            first: Number(e.target.value) || 0,
                          },
                        })
                      }
                      className="w-32 px-3 py-2 border rounded dark:bg-gray-800 dark:border-gray-700"
                      data-testid="mahnung-first-input"
                    />
                    <span className="ml-2 text-sm">€</span>
                  </div>
                  <div>
                    <label
                      className="block text-sm font-medium mb-1"
                      htmlFor="mahngebuehr-second-input"
                    >
                      {t("mahnung.secondStage")}
                    </label>
                    <input
                      id="mahngebuehr-second-input"
                      type="number"
                      step="0.1"
                      min={0}
                      max={1000}
                      value={cfg.mahngebuehr.second}
                      onChange={(e) =>
                        setCfg({
                          ...cfg,
                          mahngebuehr: {
                            ...cfg.mahngebuehr,
                            second: Number(e.target.value) || 0,
                          },
                        })
                      }
                      className="w-32 px-3 py-2 border rounded dark:bg-gray-800 dark:border-gray-700"
                      data-testid="mahnung-second-input"
                    />
                    <span className="ml-2 text-sm">€</span>
                  </div>
                  <div>
                    <label
                      className="block text-sm font-medium mb-1"
                      htmlFor="mahngebuehr-final-input"
                    >
                      {t("mahnung.finalStage")}
                    </label>
                    <input
                      id="mahngebuehr-final-input"
                      type="number"
                      step="0.1"
                      min={0}
                      max={1000}
                      value={cfg.mahngebuehr.final}
                      onChange={(e) =>
                        setCfg({
                          ...cfg,
                          mahngebuehr: {
                            ...cfg.mahngebuehr,
                            final: Number(e.target.value) || 0,
                          },
                        })
                      }
                      className="w-32 px-3 py-2 border rounded dark:bg-gray-800 dark:border-gray-700"
                      data-testid="mahnung-final-input"
                    />
                    <span className="ml-2 text-sm">€</span>
                  </div>
                </div>

                {savedOk && (
                  <div
                    className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded text-sm"
                    data-testid="mahnung-settings-saved"
                  >
                    ✓ {t("mahnung.savedOk")}
                  </div>
                )}

                <div className="flex gap-3 pt-4">
                  <Button
                    onClick={handleSave}
                    disabled={saving}
                    data-testid="mahnung-settings-save"
                  >
                    {saving ? "…" : t("mahnung.saveSettings")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={resetDefaults}
                    data-testid="mahnung-settings-reset"
                  >
                    {t("mahnung.resetDefaults")}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  )
}