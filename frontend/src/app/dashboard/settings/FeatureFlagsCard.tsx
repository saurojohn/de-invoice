"use client"

import { useEffect, useState, useRef, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, apiPatch, ApiError } from "@/lib/api"

interface FeatureFlags {
  autoBookAfa: boolean
  anlageV: boolean
  nextAutoBookerRun: string
}

/**
 * Tier 94: Feature flags card.
 *
 * The backend has 2 per-company feature flags
 * stored on Company.settings (JSONB):
 *
 *   - autoBookAfa (default = true). The
 *     AfaAutoBookerScheduler (tier 91) reads
 *     this on every company to decide whether
 *     to book the previous month. Set to false
 *     to opt out (the user does the AfA booking
 *     manually).
 *
 *   - anlageV (default = false). The Berater
 *     packager (tier 85) reads this to decide
 *     whether to include 03_Anlage-V.pdf in
 *     the year-end ZIP. Set to true to force
 *     inclusion (for landlords without
 *     building assets in the Anlagenverzeichnis).
 *
 * Each toggle is an explicit "Speichern"
 * action — we don't auto-save on every change
 * because (a) the user should see the
 * before/after diff before committing and
 * (b) the autoBookAfa flip is a meaningful
 * decision (the cron will respect it on the
 * next 1st of the month).
 */
export function FeatureFlagsCard() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t

  const [flags, setFlags] = useState<FeatureFlags | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  // Local draft state — the user toggles these
  // and clicks "Speichern" to commit. Reset
  // on successful save.
  const [draft, setDraft] = useState<{ autoBookAfa: boolean; anlageV: boolean } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      if (!companyId) return
      const result = await apiGet<FeatureFlags>(`/api/v1/companies/${companyId}/feature-flags`)
      setFlags(result)
      setDraft({
        autoBookAfa: result.autoBookAfa,
        anlageV: result.anlageV,
      })
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const save = useCallback(async () => {
    if (!draft || !flags) return
    setSaving(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      if (!companyId) return
      // Send only the keys that changed — the
      // PATCH endpoint ignores keys it doesn't
      // receive. This makes the round-trip
      // idempotent (no "set to the same value"
      // side effects).
      const body: { autoBookAfa?: boolean; anlageV?: boolean } = {}
      if (draft.autoBookAfa !== flags.autoBookAfa) body.autoBookAfa = draft.autoBookAfa
      if (draft.anlageV !== flags.anlageV) body.anlageV = draft.anlageV
      if (Object.keys(body).length === 0) {
        toastRef.current.info(tRef.current("featureFlags.noChanges"))
        setSaving(false)
        return
      }
      await apiPatch(`/api/v1/companies/${companyId}/feature-flags`, body)
      toastRef.current.success(tRef.current("featureFlags.savedOk"))
      // Reload to confirm the server state matches
      // our draft.
      await load()
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setSaving(false)
    }
  }, [draft, flags, load])

  if (loading && !flags) {
    return (
      <Card data-testid="feature-flags-card">
        <CardHeader>
          <CardTitle>{tRef.current("featureFlags.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-gray-500">…</div>
        </CardContent>
      </Card>
    )
  }

  if (!flags || !draft) return null

  const dirty =
    draft.autoBookAfa !== flags.autoBookAfa || draft.anlageV !== flags.anlageV

  return (
    <Card data-testid="feature-flags-card">
      <CardHeader>
        <CardTitle>{tRef.current("featureFlags.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {tRef.current("featureFlags.subtitle")}
        </p>

        {/* Auto-AfA toggle */}
        <div
          className="flex items-start justify-between gap-4 p-3 border rounded dark:border-gray-700"
          data-testid="feature-flag-auto-book-afa"
        >
          <div className="flex-1">
            <div className="font-medium text-sm">
              {tRef.current("featureFlags.autoBookAfa.label")}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {tRef.current("featureFlags.autoBookAfa.description")}
            </div>
            {flags.nextAutoBookerRun && (
              <div className="text-xs text-gray-400 mt-1">
                {tRef.current("featureFlags.autoBookAfa.nextRunLabel")}{" "}
                <span data-testid="feature-flag-auto-book-afa-next-run">
                  {new Date(flags.nextAutoBookerRun).toLocaleDateString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}
                </span>
              </div>
            )}
          </div>
          <label className="inline-flex items-center cursor-pointer mt-1">
            <input
              type="checkbox"
              className="sr-only"
              checked={draft.autoBookAfa}
              onChange={(e) =>
                setDraft({ ...draft, autoBookAfa: e.target.checked })
              }
              data-testid="feature-flag-auto-book-afa-toggle"
            />
            <span
              className={`w-11 h-6 rounded-full relative transition-colors ${
                draft.autoBookAfa
                  ? "bg-emerald-500"
                  : "bg-gray-300 dark:bg-gray-600"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                  draft.autoBookAfa ? "translate-x-5" : ""
                }`}
              />
            </span>
          </label>
        </div>

        {/* Anlage V toggle */}
        <div
          className="flex items-start justify-between gap-4 p-3 border rounded dark:border-gray-700"
          data-testid="feature-flag-anlage-v"
        >
          <div className="flex-1">
            <div className="font-medium text-sm">
              {tRef.current("featureFlags.anlageV.label")}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {tRef.current("featureFlags.anlageV.description")}
            </div>
            <div className="text-xs text-gray-400 mt-1">
              {tRef.current("featureFlags.anlageV.effectLabel")}
            </div>
          </div>
          <label className="inline-flex items-center cursor-pointer mt-1">
            <input
              type="checkbox"
              className="sr-only"
              checked={draft.anlageV}
              onChange={(e) =>
                setDraft({ ...draft, anlageV: e.target.checked })
              }
              data-testid="feature-flag-anlage-v-toggle"
            />
            <span
              className={`w-11 h-6 rounded-full relative transition-colors ${
                draft.anlageV
                  ? "bg-emerald-500"
                  : "bg-gray-300 dark:bg-gray-600"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                  draft.anlageV ? "translate-x-5" : ""
                }`}
              />
            </span>
          </label>
        </div>

        <div className="flex items-center gap-3 pt-2 border-t dark:border-gray-700">
          <Button
            onClick={save}
            disabled={!dirty || saving}
            data-testid="feature-flags-save"
          >
            {saving ? "..." : tRef.current("featureFlags.save")}
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              setDraft({
                autoBookAfa: flags.autoBookAfa,
                anlageV: flags.anlageV,
              })
            }
            disabled={!dirty || saving}
            data-testid="feature-flags-reset"
          >
            {tRef.current("featureFlags.reset")}
          </Button>
          {dirty && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {tRef.current("featureFlags.unsaved")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
