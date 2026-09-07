"use client"

/**
 * Tier 68: Global Search — ⌘K command bar.
 *
 * A modal that opens on `⌘K` (or `Ctrl+K` on
 * Windows / Linux). Renders a debounced search
 * input + grouped hit list (Customers / Invoices
 * / Products). Arrow keys navigate, Enter opens
 * the selected hit's detail page, Esc closes.
 *
 * Mounted once in the root layout so the
 * shortcut works on every dashboard page.
 *
 * Why a modal instead of a top-bar: a top-bar
 * search input is hidden in the page header on
 * most pages (long headers, narrow viewports).
 * A modal is always full-width, always
 * centered, and works the same on mobile.
 *
 * Why ⌘K specifically: it's the universal
 * "command bar" shortcut (VS Code, Slack,
 * Linear, GitHub, etc.). Users trained on any
 * of those expect ⌘K to open search.
 *
 * Why no results-ranker tuning: we trust the
 * backend's per-entity ts_rank order. The UI
 * just groups by type and caps each group at
 * the per-group limit. If we ever need to
 * re-rank globally, it's a backend change.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useI18n } from "@/components/useI18n"
import { apiGet } from "@/lib/api"

interface GlobalHit {
  id: string
  title: string
  subtitle: string
  snippet: string
  rank: number
}

interface GlobalGroup {
  type: "customer" | "invoice" | "product"
  count: number
  hits: GlobalHit[]
}

interface GlobalSearchResponse {
  query: string
  totalHits: number
  groups: GlobalGroup[]
}

const DEBOUNCE_MS = 200
const PER_GROUP_LIMIT = 5

export default function GlobalSearch() {
  const router = useRouter()
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<GlobalSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Flatten the grouped hits into a single navigable
  // list so arrow keys can move through all of them
  // in order (Customers → Products → Invoices).
  const flatHits: { group: GlobalGroup; hit: GlobalHit }[] = []
  if (results?.groups) {
    for (const g of results.groups) {
      for (const h of g.hits) {
        flatHits.push({ group: g, hit: h })
      }
    }
  }

  // Open on ⌘K / Ctrl+K from anywhere on the page.
  // We bind to document, not the input, so the
  // shortcut works even when the user hasn't
  // focused the search box yet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isK = e.key === "k" || e.key === "K"
      if (isK && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === "Escape" && open) {
        setOpen(false)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  // Focus the input when the modal opens.
  useEffect(() => {
    if (open) {
      // The setTimeout is needed because the input
      // is mounted just before the focus call —
      // React hasn't painted it yet. 0ms is
      // usually enough; 50ms is bulletproof.
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      setQuery("")
      setResults(null)
      setSelectedIndex(0)
    }
  }, [open])

  // Debounced search. 200ms is the sweet spot:
  //   - fast enough that the user sees results
  //     before they finish typing
  //   - slow enough that we don't fire a request
  //     on every keystroke (5 chars in 1s would
  //     be 5 requests)
  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim().length < 2) {
      setResults(null)
      setLoading(false)
      return
    }
    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const companyId =
          (typeof window !== "undefined" &&
            localStorage.getItem("companyId")) ||
          ""
        if (!companyId) {
          setResults({ query, totalHits: 0, groups: [] })
          setLoading(false)
          return
        }
        const data = await apiGet<GlobalSearchResponse>(
          `/api/v1/search/global?companyId=${encodeURIComponent(
            companyId,
          )}&q=${encodeURIComponent(query)}&limit=${PER_GROUP_LIMIT}`,
        )
        setResults(data)
        setSelectedIndex(0)
      } catch (e) {
        // Silent — the modal stays open, the
        // user can keep typing. We don't
        // surface a toast for a search miss.
        setResults({ query, totalHits: 0, groups: [] })
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, open])

  const navigate = useCallback(
    (group: GlobalGroup, hit: GlobalHit) => {
      setOpen(false)
      switch (group.type) {
        case "customer":
          router.push(`/dashboard/customers/${hit.id}`)
          break
        case "invoice":
          router.push(`/dashboard/invoices/${hit.id}`)
          break
        case "product":
          router.push(`/dashboard/products/${hit.id}`)
          break
      }
    },
    [router],
  )

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(flatHits.length - 1, i + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(0, i - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const sel = flatHits[selectedIndex]
      if (sel) navigate(sel.group, sel.hit)
    }
  }

  if (!open) {
    // Render a tiny hint button in the corner so
    // users on a new device can discover the
    // shortcut. Hidden on small viewports — the
    // keyboard shortcut is the primary path.
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-800 text-white text-xs shadow-lg hover:bg-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600"
        data-testid="global-search-trigger"
        title={t("globalSearch.shortcut") || "Suche (⌘K)"}
      >
        🔍{" "}
        <kbd className="px-1.5 py-0.5 rounded bg-gray-700 dark:bg-gray-800 text-[10px]">
          ⌘K
        </kbd>
      </button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-[10vh] px-4"
      onClick={() => setOpen(false)}
      data-testid="global-search-modal"
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-2xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-200 dark:border-gray-700 p-3 flex items-center gap-2">
          <span className="text-gray-400">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={t("globalSearch.placeholder") || "Suchen..."}
            className="flex-1 bg-transparent outline-none text-base text-gray-900 dark:text-gray-100"
            data-testid="global-search-input"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <span className="text-xs text-gray-400" data-testid="global-search-loading">
              …
            </span>
          )}
          <kbd className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-xs text-gray-500">
            Esc
          </kbd>
        </div>
        <div
          className="max-h-[60vh] overflow-y-auto"
          data-testid="global-search-results"
        >
          {!query || query.trim().length < 2 ? (
            <div className="p-6 text-sm text-gray-500 text-center">
              {t("globalSearch.hint") ||
                "Tippe mindestens 2 Zeichen, um Kunden, Rechnungen oder Produkte zu suchen."}
            </div>
          ) : results && results.totalHits === 0 ? (
            <div className="p-6 text-sm text-gray-500 text-center" data-testid="global-search-empty">
              {t("globalSearch.empty") || "Keine Treffer"}
            </div>
          ) : (
            results?.groups.map((g) => (
              <div
                key={g.type}
                className="border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                data-testid={`global-search-group-${g.type}`}
              >
                <div className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase">
                  {groupLabel(g.type, t)}
                </div>
                {g.hits.map((h, _idx) => {
                  // Compute the flat index for the
                  // keyboard nav highlight.
                  const flatIdx = flatHits.findIndex(
                    (fh) => fh.hit.id === h.id && fh.group.type === g.type,
                  )
                  const isSel = flatIdx === selectedIndex
                  return (
                    <button
                      key={`${g.type}-${h.id}`}
                      onClick={() => navigate(g, h)}
                      onMouseEnter={() => setSelectedIndex(flatIdx)}
                      className={`w-full text-left px-4 py-2 flex items-center justify-between ${
                        isSel
                          ? "bg-blue-50 dark:bg-blue-900/30"
                          : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      }`}
                      data-testid="global-search-hit"
                      data-hit-type={g.type}
                      data-hit-id={h.id}
                    >
                      <div className="flex-1 min-w-0">
                        <div
                          className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate"
                          dangerouslySetInnerHTML={{ __html: h.snippet }}
                        />
                        {h.subtitle && (
                          <div className="text-xs text-gray-500 truncate">
                            {h.subtitle}
                          </div>
                        )}
                      </div>
                      <span className="ml-2 text-xs text-gray-400 shrink-0">
                        {typeIcon(g.type)}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 p-2 text-xs text-gray-500 flex items-center justify-between">
          <span>
            {results &&
              `${results.totalHits} ${t("globalSearch.hits") || "Treffer"}`}
          </span>
          <span>
            <kbd className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700">
              ↑↓
            </kbd>{" "}
            {t("globalSearch.navigate") || "navigieren"}{" "}
            <kbd className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700">
              ↵
            </kbd>{" "}
            {t("globalSearch.open") || "öffnen"}
          </span>
        </div>
      </div>
    </div>
  )
}

function groupLabel(
  type: "customer" | "invoice" | "product",
  t: (k: string) => string,
): string {
  switch (type) {
    case "customer":
      return t("globalSearch.groupCustomers") || "Kunden"
    case "invoice":
      return t("globalSearch.groupInvoices") || "Rechnungen"
    case "product":
      return t("globalSearch.groupProducts") || "Produkte"
  }
}

function typeIcon(type: "customer" | "invoice" | "product"): string {
  switch (type) {
    case "customer":
      return "👤"
    case "invoice":
      return "📄"
    case "product":
      return "📦"
  }
}
