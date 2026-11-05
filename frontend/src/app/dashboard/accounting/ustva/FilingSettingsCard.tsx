"use client"

/**
 * Tier 801 — the UStVA rhythm and the Dauerfristverlängerung, as the
 * Finanzamt set them (PUT /ustva/filing-settings). The deadlines on the
 * dashboard and the period this page opens on follow them; until they are
 * set they are taken from the books, and the card says so.
 */
import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiPut } from "@/lib/api"
import { loadFilingDeadlines, type FilingDeadlines, type UstvaRhythm } from "@/lib/filing-deadlines"

const SOURCE_KEY: Record<string, string> = {
  setting: "deadlines.sourceSetting",
  filings: "deadlines.sourceFilings",
  kleinunternehmer: "deadlines.sourceKleinunternehmer",
  default: "deadlines.sourceDefault",
  sondervorauszahlung: "deadlines.sourceSondervorauszahlung",
}

export default function FilingSettingsCard({ initial, onSaved }: { initial: FilingDeadlines | null; onSaved: (d: FilingDeadlines | null) => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const [saving, setSaving] = useState(false)
  if (!initial) return null

  const save = async (patch: { ustvaRhythmus?: UstvaRhythm; dauerfristverlaengerung?: boolean }) => {
    const companyId = localStorage.getItem("companyId")
    if (!companyId) return
    setSaving(true)
    try {
      await apiPut(`/api/v1/ustva/filing-settings?companyId=${companyId}`, patch)
      onSaved(await loadFilingDeadlines(true))
      toast.success(t("deadlines.settingsSaved"))
    } catch (e: any) {
      toast.error(e?.message || t("common.saveError"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mb-6" id="filing-settings" data-testid="ustva-filing-settings">
      <CardContent className="pt-6">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">{t("deadlines.settingsTitle")}</div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label className="flex flex-wrap items-center gap-2 min-w-0">
            <span>{t("deadlines.settingsRhythm")}</span>
            <select
              value={initial.rhythm}
              disabled={saving}
              onChange={(e) => save({ ustvaRhythmus: e.target.value as UstvaRhythm })}
              className="max-w-full px-2 py-1 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800"
              data-testid="ustva-rhythm"
            >
              <option value="monthly">{t("deadlines.settingsMonthly")}</option>
              <option value="quarterly">{t("deadlines.settingsQuarterly")}</option>
              <option value="none">{t("deadlines.settingsNone")}</option>
            </select>
            <span className="text-xs text-gray-500" data-testid="ustva-rhythm-source">{t(SOURCE_KEY[initial.rhythmSource])}</span>
          </label>
          <label className="flex flex-wrap items-center gap-2 min-w-0">
            <input
              type="checkbox"
              checked={initial.dauerfrist}
              disabled={saving || initial.rhythm === "none"}
              onChange={(e) => save({ dauerfristverlaengerung: e.target.checked })}
              data-testid="ustva-dauerfrist"
            />
            <span>{t("deadlines.settingsDauerfrist")}</span>
            <span className="text-xs text-gray-500" data-testid="ustva-dauerfrist-source">{t(SOURCE_KEY[initial.dauerfristSource])}</span>
          </label>
        </div>
      </CardContent>
    </Card>
  )
}
