"use client"

import { useEffect, useRef, useState } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"

/**
 * Tier 85: Anlage Steuererklärung packager section.
 *
 * Top-of-page callout on /dashboard/accounting
 * that gives the Mandant one click to bundle
 * every VORSCHAU report into a single ZIP for
 * the year-end handover to the Berater. The
 * download goes to the full backend URL
 * (NEXT_PUBLIC_API_URL) per the tier-76
 * dev-server proxy lesson.
 */
export function BeraterPackagerSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)

  const [zipUrl, setZipUrl] = useState<string>("#")
  useEffect(() => {
    if (typeof window === "undefined") return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setZipUrl("#")
      return
    }
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    setZipUrl(`${apiBase}/api/v1/accounting/berater-packager?companyId=${companyId}&year=${year}`)
  }, [year])

  return (
    <Card className="mb-4 border-blue-200 dark:border-blue-700 bg-blue-50/30 dark:bg-blue-900/10" data-testid="berater-packager-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>📦</span>
          <span>{tRef.current("packager.title")}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          {tRef.current("packager.subtitle")}
        </p>
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
              {tRef.current("packager.year")}
            </label>
            <input
              type="number"
              min={2000}
              max={2100}
              value={year}
              onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear() - 1)}
              className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
              data-testid="berater-packager-year"
            />
          </div>
          <a
            href={zipUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="berater-packager-download"
          >
            <Button
              type="button"
              disabled={zipUrl === "#"}
              className="bg-blue-600 text-white hover:bg-blue-700"
            >
              📦 {tRef.current("packager.downloadZip")}
            </Button>
          </a>
        </div>

        <details className="text-xs text-gray-600 dark:text-gray-300" data-testid="berater-packager-contents">
          <summary className="cursor-pointer font-semibold mb-2">
            {tRef.current("packager.contents")}
          </summary>
          <ul className="space-y-1 pl-4 list-disc">
            <li>{tRef.current("packager.contentEuer")}</li>
            <li>{tRef.current("packager.contentAnlageS")}</li>
            <li>{tRef.current("packager.contentBilanz")}</li>
            <li>{tRef.current("packager.contentGuv")}</li>
            <li>{tRef.current("packager.contentAnhang")}</li>
            <li>{tRef.current("packager.contentAssetCsv")}</li>
            <li>{tRef.current("packager.contentManifest")}</li>
          </ul>
        </details>

        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400" data-testid="berater-packager-disclaimer">
          ⚠ {tRef.current("packager.previewHint")}
        </p>
      </CardContent>
    </Card>
  )
}
