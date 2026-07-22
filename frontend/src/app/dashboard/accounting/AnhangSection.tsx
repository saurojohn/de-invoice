"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { apiGet, ApiError } from "@/lib/api"

interface AnhangParagraph {
  auto: boolean
  text: string
}

interface AnhangSection {
  title: string
  paragraphs: AnhangParagraph[]
}

interface AnhangResult {
  year: number
  companyId: string
  company: {
    name: string
    legalName: string | null
    address: string | null
    taxId: string | null
    vatId: string | null
    registerEntry: string | null
    managingDirector: string | null
  }
  sections: AnhangSection[]
  counts: {
    bilanzNichtAusgewiesen: number
    bilanzComputed: number
    guvNichtAusgewiesen: number
    guvComputed: number
  }
  generatedAt: string
  disclaimer: string
}

/**
 * Tier 84: Anhang zum Jahresabschluss section.
 *
 * Renders the § 284 HGB Anhang as 5 collapsible
 * sections (I-V) with each paragraph tagged
 * "auto-generated" or "vom Berater zu ergänzen".
 * The Berater scans the auto-generated content
 * + fills in the § 285 HGB Pflichtangaben
 * (Haftungsverhältnisse, related-party, etc.)
 * before the filing.
 */
export function AnhangSection() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<AnhangResult | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (y: number) => {
    setLoading(true)
    try {
      const companyId =
        typeof window !== "undefined" ? localStorage.getItem("companyId") : null
      const params = new URLSearchParams()
      if (companyId) params.set("companyId", companyId)
      params.set("year", String(y))
      const result = await apiGet<AnhangResult>(`/api/v1/accounting/anhang?${params}`)
      setData(result)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : tRef.current("common.loadError")
      toastRef.current.error(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(year)
  }, [year, load])

  const [pdfUrl, setPdfUrl] = useState<string>("#")
  useEffect(() => {
    if (typeof window === "undefined") return
    const companyId = localStorage.getItem("companyId")
    if (!companyId) {
      setPdfUrl("#")
      return
    }
    const apiBase = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
    setPdfUrl(`${apiBase}/api/v1/accounting/anhang.pdf?companyId=${companyId}&year=${year}`)
  }, [year])

  // Section titles come from the backend in
  // German (HGB-canonical, like the Bilanz /
  // G+V titles). Map the prefix to localised
  // labels.
  const sectionTitleKey = (s: AnhangSection): string | null => {
    if (s.title.startsWith("I. Allgemeine")) return "anhang.sectionI"
    if (s.title.startsWith("II. Bilanzierungs")) return "anhang.sectionII"
    if (s.title.startsWith("III. Erläuterungen zur Bilanz")) return "anhang.sectionIII"
    if (s.title.startsWith("IV. Erläuterungen zur G+V")) return "anhang.sectionIV"
    if (s.title.startsWith("V. Sonstige")) return "anhang.sectionV"
    return null
  }

  return (
    <div className="mt-6 space-y-4" data-testid="anhang-section">
      <Card>
        <CardHeader>
          <CardTitle>
            📜 {tRef.current("anhang.title")} ({data?.year || year})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("anhang.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("anhang.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear() - 1)}
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="anhang-year"
              />
            </div>
            <Button onClick={() => load(year)} disabled={loading} data-testid="anhang-recompute">
              {loading ? "..." : tRef.current("anhang.recompute")}
            </Button>
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="ml-auto" data-testid="anhang-pdf-link">
              <Button variant="outline" type="button" disabled={pdfUrl === "#"}>
                📄 {tRef.current("anhang.downloadPdf")}
              </Button>
            </a>
          </div>

          {data && (
            <>
              {/* Counts strip — transparency on how
                  much was auto-generated vs nicht
                  ausgewiesen. */}
              <div
                className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-xs grid grid-cols-2 gap-2"
                data-testid="anhang-counts"
              >
                <div>
                  {tRef.current("anhang.countsBilanz")}: <b>{data.counts.bilanzComputed}</b>{" "}
                  {tRef.current("anhang.ausgewiesen")}, <b>{data.counts.bilanzNichtAusgewiesen}</b>{" "}
                  {tRef.current("anhang.nichtAusgewiesen")}
                </div>
                <div>
                  {tRef.current("anhang.countsGuv")}: <b>{data.counts.guvComputed}</b>{" "}
                  {tRef.current("anhang.ausgewiesen")}, <b>{data.counts.guvNichtAusgewiesen}</b>{" "}
                  {tRef.current("anhang.nichtAusgewiesen")}
                </div>
              </div>

              {/* Sections (5) */}
              <div className="space-y-4">
                {data.sections.map((section, idx) => {
                  const titleKey = sectionTitleKey(section)
                  return (
                    <div
                      key={section.title}
                      className="border border-gray-200 dark:border-gray-700 rounded p-3"
                      data-testid={`anhang-section-${idx + 1}`}
                    >
                      <h4 className="text-sm font-semibold mb-2 text-gray-700 dark:text-gray-200">
                        {titleKey ? tRef.current(titleKey) : section.title}
                      </h4>
                      <div className="space-y-2">
                        {section.paragraphs.map((p, pidx) => (
                          <div
                            key={pidx}
                            className={`text-sm rounded p-2 ${
                              p.auto
                                ? "bg-emerald-50 dark:bg-emerald-900/20 text-gray-800 dark:text-gray-200 border-l-2 border-emerald-500"
                                : "bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 border-l-2 border-amber-500"
                            }`}
                            data-testid={`anhang-para-${idx + 1}-${pidx}`}
                          >
                            <div className="text-[10px] uppercase tracking-wide mb-1 font-semibold opacity-70">
                              {p.auto
                                ? `✓ ${tRef.current("anhang.autoHint")}`
                                : `⚠ ${tRef.current("anhang.beraterHint")}`}
                            </div>
                            <div>{p.text}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>

              <div
                className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded text-xs text-amber-800 dark:text-amber-200"
                data-testid="anhang-disclaimer"
              >
                ⚠ {data.disclaimer}
              </div>

              <div className="mt-2 text-xs text-gray-500" data-testid="anhang-generatedAt">
                {tRef.current("anhang.generatedAt")}:{" "}
                {new Date(data.generatedAt).toLocaleString("de-DE")}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
