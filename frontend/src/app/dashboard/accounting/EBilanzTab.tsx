"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import LanguageSwitcher from "@/components/LanguageSwitcher"
import { useI18n } from "@/components/useI18n"
import { useToast } from "@/components/useToast"
import { API_BASE, apiGet } from "@/lib/api"

interface EBilanzPosition {
  elementId: string
  label: string
  source: string
  // Tier 97 (v2): 17 sub-sections matching
  // the BMF GCD 6.7 schema (Aktiva/Passiva
  // split into 5 each, G+V into 5, sonstige).
  // Tier 88 (v1) had 4 sections only.
  section:
    | "bilanzAktivaAnlage"
    | "bilanzAktivaUmlauf"
    | "bilanzAktivaRap"
    | "bilanzAktivaLatent"
    | "bilanzAktivaSumme"
    | "bilanzPassivaEigenkapital"
    | "bilanzPassivaRueckstellungen"
    | "bilanzPassivaVerbindlichkeiten"
    | "bilanzPassivaRap"
    | "bilanzPassivaLatent"
    | "bilanzPassivaSumme"
    | "guvErträge"
    | "guvAufwendungen"
    | "guvFinanzergebnis"
    | "guvSteuern"
    | "guvJahresergebnis"
    | "sonstige"
  computed: boolean
  value: number | null
  note?: string
}

interface EBilanzData {
  year: number
  companyId: string
  company: {
    name: string
    legalName: string | null
    taxId: string | null
    registerEntry: string | null
    managingDirector: string | null
  }
  positions: EBilanzPosition[]
  counts: {
    total: number
    computed: number
    placeholder: number
  }
  mappingStats: {
    total: number
    computed: number
    bySection: Record<string, number>
  }
  generatedAt: string
  disclaimer: string
}

function fmtEur(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—"
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(n)
}

const SECTION_ORDER: Array<EBilanzPosition["section"]> = [
  "bilanzAktivaAnlage",
  "bilanzAktivaUmlauf",
  "bilanzAktivaRap",
  "bilanzAktivaLatent",
  "bilanzAktivaSumme",
  "bilanzPassivaEigenkapital",
  "bilanzPassivaRueckstellungen",
  "bilanzPassivaVerbindlichkeiten",
  "bilanzPassivaRap",
  "bilanzPassivaLatent",
  "bilanzPassivaSumme",
  "guvErträge",
  "guvAufwendungen",
  "guvFinanzergebnis",
  "guvSteuern",
  "guvJahresergebnis",
  "sonstige",
]

const SECTION_TITLE: Record<EBilanzPosition["section"], string> = {
  bilanzAktivaAnlage: "Aktiva — Anlagevermögen",
  bilanzAktivaUmlauf: "Aktiva — Umlaufvermögen",
  bilanzAktivaRap: "Aktiva — Rechnungsabgrenzungsposten",
  bilanzAktivaLatent: "Aktiva — Latente Steuern",
  bilanzAktivaSumme: "Aktiva — Summe",
  bilanzPassivaEigenkapital: "Passiva — Eigenkapital",
  bilanzPassivaRueckstellungen: "Passiva — Rückstellungen",
  bilanzPassivaVerbindlichkeiten: "Passiva — Verbindlichkeiten",
  bilanzPassivaRap: "Passiva — Rechnungsabgrenzungsposten",
  bilanzPassivaLatent: "Passiva — Latente Steuern",
  bilanzPassivaSumme: "Passiva — Summe",
  guvErträge: "G+V — Betriebliche Erträge",
  guvAufwendungen: "G+V — Betriebliche Aufwendungen",
  guvFinanzergebnis: "G+V — Finanzergebnis",
  guvSteuern: "G+V — Steuern",
  guvJahresergebnis: "G+V — Jahresergebnis",
  sonstige: "Sonstige — Anhang / Lagebericht / Generelle Infos",
}

/**
 * Tier 88: E-Bilanz (XBRL) VORSCHAU tab.
 *
 * Renders the eBilanz mapping table for the
 * selected year — the same BMF Taxonomy 6.7
 * positions that the .xbrl file uses. The
 * user can review the mapping, then download
 * the .xbrl (for ELSTER upload) and .pdf (for
 * Berater review) via the action buttons.
 *
 * The download URLs use the full backend
 * (NEXT_PUBLIC_API_URL) per the tier-76
 * dev-server proxy lesson — relative
 * /api/v1/* paths would hit Next.js dev and
 * 404.
 */
export function EBilanzTab() {
  const { t } = useI18n()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const [year, setYear] = useState<number>(new Date().getFullYear() - 1)
  const [data, setData] = useState<EBilanzData | null>(null)
  const [loading, setLoading] = useState(true)
  const [companyId, setCompanyId] = useState<string | null>(null)

  // Per tier-76 lesson: localStorage values
  // must be read in useState + useEffect, not
  // inline in the component body. Otherwise
  // the URL is computed during SSR (where
  // localStorage is unavailable) and the
  // download link falls back to "#".
  useEffect(() => {
    if (typeof window === "undefined") return
    setCompanyId(localStorage.getItem("companyId"))
  }, [])

  // Tier 363: one API base for the whole app (src/lib/api.ts).
  const apiBase = API_BASE

  const xmlUrl = companyId
    ? `${apiBase}/api/v1/accounting/ebilanz.xml?companyId=${companyId}&year=${year}`
    : "#"
  const pdfUrl = companyId
    ? `${apiBase}/api/v1/accounting/ebilanz.pdf?companyId=${companyId}&year=${year}`
    : "#"

  const load = useCallback(async () => {
    const companyId =
      typeof window !== "undefined" ? localStorage.getItem("companyId") : null
    if (!companyId) return
    setLoading(true)
    try {
      const d = await apiGet<EBilanzData>(
        `/api/v1/accounting/ebilanz?companyId=${companyId}&year=${year}`,
      )
      setData(d)
    } catch (e) {
      console.error("ebilanz load failed", e)
      toastRef.current.error("Fehler beim Laden der E-Bilanz")
    } finally {
      setLoading(false)
    }
  }, [year])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-4" data-testid="ebilanz-tab">
      <Card className="border-emerald-200 dark:border-emerald-700 bg-emerald-50/30 dark:bg-emerald-900/10">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span>📊</span>
            <span>{tRef.current("ebilanz.title")}</span>
            <span className="ml-auto">
              <LanguageSwitcher />
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
            {tRef.current("ebilanz.subtitle")}
          </p>
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                {tRef.current("ebilanz.year")}
              </label>
              <input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) =>
                  setYear(Number(e.target.value) || new Date().getFullYear() - 1)
                }
                className="border rounded px-3 py-2 w-32 dark:bg-gray-800 dark:border-gray-700"
                data-testid="ebilanz-year"
              />
            </div>
            <a
              href={xmlUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="ebilanz-download-xml"
            >
              <Button
                type="button"
                disabled={xmlUrl === "#"}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                📥 {tRef.current("ebilanz.downloadXml")}
              </Button>
            </a>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="ebilanz-download-pdf"
            >
              <Button
                type="button"
                disabled={pdfUrl === "#"}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                📄 {tRef.current("ebilanz.downloadPdf")}
              </Button>
            </a>
          </div>
          {data && (
            <div
              className="text-sm font-mono mb-4 px-3 py-2 bg-white dark:bg-gray-800 border rounded"
              data-testid="ebilanz-counts"
            >
              {tRef.current("ebilanz.positionCount")
                .replace("{computed}", String(data.counts.computed))
                .replace("{total}", String(data.counts.total))}
            </div>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {tRef.current("ebilanz.vorschau")}
          </p>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-100 dark:bg-gray-800 rounded animate-pulse" />
          ))}
        </div>
      ) : data ? (
        <Card>
          <CardHeader>
            <CardTitle>{tRef.current("ebilanz.mappingTable")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm table-fixed" data-testid="ebilanz-table">
                <thead>
                  <tr className="border-b text-xs text-gray-500 dark:text-gray-400">
                    <th className="text-left py-2 px-2 break-all">BMF-Element</th>
                    <th className="text-left py-2 px-2">
                      {tRef.current("ebilanz.positionLabel")}
                    </th>
                    <th className="text-right py-2 px-2 w-24">
                      {tRef.current("ebilanz.value")}
                    </th>
                    <th className="text-left py-2 px-2 hidden sm:table-cell">
                      {tRef.current("ebilanz.source")}
                    </th>
                    <th className="text-center py-2 px-2 w-16">
                      {tRef.current("ebilanz.status")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {SECTION_ORDER.map((section) => {
                    const rows = data.positions.filter(
                      (p) => p.section === section,
                    )
                    if (rows.length === 0) return null
                    return (
                      <SectionGroup
                        key={section}
                        section={section}
                        rows={rows}
                        title={SECTION_TITLE[section]}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
              {data.disclaimer}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function SectionGroup({
  section,
  rows,
  title,
}: {
  section: EBilanzPosition["section"]
  rows: EBilanzPosition[]
  title: string
}) {
  // Tier 97 (v2): per-section computed
  // count is shown next to the section
  // title so the user can see at a
  // glance which sub-sections are
  // fully auto-computed vs need
  // Berater hand-fill.
  const computedCount = rows.filter(
    (p) => p.computed && p.value !== null,
  ).length
  return (
    <>
      <tr
        className="bg-gray-50 dark:bg-gray-800/50"
        data-testid={`ebilanz-section-${section}`}
      >
        <td
          colSpan={5}
          className="py-2 px-2 text-xs uppercase font-bold text-gray-600 dark:text-gray-300"
        >
          <span>{title}</span>
          <span
            className="ml-2 font-mono normal-case text-[10px] text-gray-500 dark:text-gray-400"
            data-testid={`ebilanz-section-${section}-count`}
          >
            ({computedCount} / {rows.length} berechnet)
          </span>
        </td>
      </tr>
      {rows.map((p) => (
        <tr
          key={p.elementId}
          className="border-b"
          data-testid={`ebilanz-row-${p.elementId}`}
        >
          <td className="py-2 px-2 font-mono text-xs break-all">{p.elementId}</td>
          <td className="py-2 px-2 text-xs break-words">{p.label}</td>
          <td
            className={`py-2 px-2 text-right font-mono text-xs w-24 ${
              p.value !== null ? "font-bold" : "text-gray-400"
            }`}
          >
            {fmtEur(p.value)}
          </td>
          <td className="py-2 px-2 font-mono text-[10px] text-gray-500 hidden sm:table-cell">
            {p.source}
          </td>
          <td className="py-2 px-2 text-center w-16">
            {p.computed && p.value !== null ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800">
                ✓
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800"
                title={p.note}
              >
                —
              </span>
            )}
          </td>
        </tr>
      ))}
    </>
  )
}
