/**
 * Tier 731 — print a PDF fetched with the auth headers: a same-origin blob URL
 * in a new tab, then the browser's print dialog (as „Speichern und drucken“
 * does on the invoice form). Returns false when the tab could not be opened
 * (a pop-up blocker) — the caller says so.
 */
export function printPdfBlob(blob: Blob): boolean {
  const url = URL.createObjectURL(blob)
  const w = window.open(url, "_blank")
  if (!w) {
    URL.revokeObjectURL(url)
    return false
  }
  // the PDF viewer needs a moment before print() opens the dialog
  setTimeout(() => {
    try {
      w.focus()
      w.print()
    } catch {
      // the tab was closed — the user can still print from it
    }
  }, 1500)
  setTimeout(() => URL.revokeObjectURL(url), 120000)
  return true
}
