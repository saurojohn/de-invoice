"use client"

// Tier 389: every protected backend route needs the x-user-id / x-company-id
// headers, and a link click cannot send headers — so the ~30 download links
// (`<a href={pdfUrl}>` for the tax forms, GoBD archive, BWA, OSS, E-Bilanz,
// activity / webhook CSVs, attachments, Kassenabschluss, …) all answered 401.
// The Playwright tests only checked the href attribute.
//
// One listener instead of 30 rewrites: a primary click on a link to the
// backend API is taken over and fetched with the auth headers
// (downloadApiFile). The links keep their href, target and download
// attributes. Programmatic `window.open` downloads call downloadApiFile directly.

import { useEffect } from "react"
import { apiPathOf, downloadApiFile } from "@/lib/api"
import { useToast } from "@/components/useToast"

export default function AuthenticatedDownloads() {
  const toast = useToast()
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null
      if (!a || a.dataset.apiDownload === "done") return
      if (window.location.pathname.startsWith("/portal")) return
      const path = apiPathOf(a.getAttribute("href") || "")
      if (!path) return
      e.preventDefault()
      const wantsDownload = a.hasAttribute("download") || /[?&]download=1\b/.test(path)
      const newTab = !wantsDownload && (a.target === "_blank" || e.metaKey || e.ctrlKey)
      downloadApiFile(path, {
        filename: a.getAttribute("download") || undefined,
        newTab,
      }).catch((err: any) => {
        toast.error(err?.message || "Download fehlgeschlagen")
      })
    }
    document.addEventListener("click", onClick)
    return () => document.removeEventListener("click", onClick)
  }, [toast])
  return null
}
