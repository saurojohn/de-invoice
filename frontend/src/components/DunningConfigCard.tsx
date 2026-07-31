"use client"

/**
 * Tier 123 — Dunning config card on the Settings page.
 *
 * 3 rows: Zahlungserinnerung (level 1), 1. Mahnung
 * (level 2), 2. Mahnung (level 3). Each row has:
 *   - daysOverdue: Werktage after due date (must be
 *     strictly increasing 1 < 2 < 3)
 *   - fee: late fee in EUR (>= 0)
 *
 * Saves to PUT /api/v1/reminders/dunning-config.
 * Reads from GET /api/v1/reminders/dunning-config.
 *
 * Client-side validation mirrors the DTO: thresholds
 * must be strictly increasing (level1 < level2 < level3).
 * If not, the Save button is disabled and an inline
 * error appears.
 *
 * The defaults (1/7/14 days, 0/5/10 EUR) match German
 * Mittelstand best practice — the Berater (Steuerberater)
 * usually only changes the fees (B2B clients often get
 * higher fees than B2C).
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPut } from "@/lib/api"

interface DunningConfig {
  level1Days: number
  level2Days: number
  level3Days: number
  level1Fee: number
  level2Fee: number
  level3Fee: number
}

const DEFAULT_CONFIG: DunningConfig = {
  level1Days: 1,
  level2Days: 7,
  level3Days: 14,
  level1Fee: 0,
  level2Fee: 5,
  level3Fee: 10,
}

const LEVEL_KEYS: Array<"level1" | "level2" | "level3"> = [
  "level1",
  "level2",
  "level3",
]

export default function DunningConfigCard() {
  const { t } = useI18n()
  const toast = useToast()
  const [config, setConfig] = useState<DunningConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const companyId =
    typeof window !== "undefined" ? localStorage.getItem("companyId") : null

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const data = await apiGet<DunningConfig>(
        `/api/v1/reminders/dunning-config?companyId=${companyId}`,
      )
      setConfig(data)
    } catch (e: any) {
      toast.error(t("dunning.loadError") + ": " + (e?.message || e))
      // Fall back to defaults so the form is still usable
      setConfig(DEFAULT_CONFIG)
    } finally {
      setLoading(false)
    }
  }, [companyId, t, toast])

  useEffect(() => {
    load()
  }, [load])

  const save = useCallback(async () => {
    if (!config) return
    setSaving(true)
    try {
      await apiPut<DunningConfig>(
        `/api/v1/reminders/dunning-config?companyId=${companyId}`,
        config,
      )
      toast.success(t("dunning.saved"))
    } catch (e: any) {
      toast.error(t("dunning.saveError") + ": " + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }, [companyId, config, t, toast])

  // Client-side monotonicity check. The DTO also
  // validates server-side; the inline check is
  // for instant feedback (the user shouldn't have
  // to wait for a round-trip to see the error).
  const isValid =
    !!config &&
    config.level1Days > 0 &&
    config.level2Days > config.level1Days &&
    config.level3Days > config.level2Days &&
    config.level1Fee >= 0 &&
    config.level2Fee >= 0 &&
    config.level3Fee >= 0

  if (loading || !config) {
    return (
      <Card data-testid="dunning-config-card">
        <CardHeader>
          <CardTitle>{t("dunning.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("common.loading") || "Wird geladen…"}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-testid="dunning-config-card">
      <CardHeader>
        <CardTitle>{t("dunning.title")}</CardTitle>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {t("dunning.subtitle")}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {LEVEL_KEYS.map((key, idx) => {
          const daysKey = `${key}Days` as keyof DunningConfig
          const feeKey = `${key}Fee` as keyof DunningConfig
          const titleKey =
            idx === 0
              ? "level1Title"
              : idx === 1
              ? "level2Title"
              : "level3Title"
          return (
            <div
              key={key}
              data-testid={`dunning-level-${idx + 1}`}
              className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-3 border-b border-gray-100 dark:border-gray-700 last:border-0"
            >
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t(`dunning.${titleKey}`)}
                </h4>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    htmlFor={`dunning-${key}-days`}
                    className="block text-xs text-gray-500 dark:text-gray-400 mb-1"
                  >
                    {t("dunning.daysOverdue")}
                  </label>
                  <Input
                    id={`dunning-${key}-days`}
                    data-testid={`dunning-${key}-days`}
                    type="number"
                    min={0}
                    value={config[daysKey]}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v) && v > 0) {
                        setConfig({ ...config, [daysKey]: v })
                      }
                    }}
                  />
                </div>
                <div>
                  <label
                    htmlFor={`dunning-${key}-fee`}
                    className="block text-xs text-gray-500 dark:text-gray-400 mb-1"
                  >
                    {t("dunning.fee")}
                  </label>
                  <Input
                    id={`dunning-${key}-fee`}
                    data-testid={`dunning-${key}-fee`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={config[feeKey]}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (Number.isFinite(v) && v >= 0) {
                        setConfig({ ...config, [feeKey]: v })
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          )
        })}

        {!isValid && (
          <p
            data-testid="dunning-error"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {t("dunning.invalidConfig")}
          </p>
        )}

        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("dunning.daysHelper")}
          </p>
          <Button
            onClick={save}
            disabled={!isValid || saving}
            data-testid="dunning-save"
            size="sm"
          >
            {saving ? "…" : t("dunning.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
