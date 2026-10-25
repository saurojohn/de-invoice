/**
 * Tier 731 / 731c — print a PDF fetched with the auth headers in the
 * browser's own print dialog, which lists the computer's printers (the
 * browser cannot be told one — the owner, 25.10.2026: „根据浏览器里的本地
 * 打印机“). Chrome and Edge preselect the printer used last.
 *
 * The PDF is loaded into a hidden frame on the page and printed from there —
 * no new tab, so no pop-up blocker. Safari, and wherever the frame cannot
 * print, open the PDF in a new tab with the dialog.
 * `onBlocked`: neither worked (a pop-up blocker) — the caller says so.
 */
export function printPdfBlob(blob: Blob, onBlocked?: () => void): void {
  const url = URL.createObjectURL(blob)
  // Safari prints a PDF in a frame blank (or prints the page around it): the tab
  if (/^((?!chrome|chromium|crios|edg|android|firefox|fxios).)*safari/i.test(navigator.userAgent)) {
    if (!viaTab(url)) onBlocked?.()
    window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000)
    return
  }
  // Tier 731e: a frame holds a PDF viewer and its file — the one of the
  // print before goes now (its dialog is closed: the dialog is modal), this
  // one after its dialog, the timeout below only if neither happens
  for (const old of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-testid="print-frame"]'))) removeFrame(old)
  const frame = document.createElement("iframe")
  frame.setAttribute("data-testid", "print-frame")
  frame.dataset.blobUrl = url
  frame.setAttribute("aria-hidden", "true")
  // off screen but rendered: a frame with display:none / visibility:hidden
  // does not load its PDF viewer in Chrome
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0"
  frame.onload = () => {
    try {
      frame.contentWindow?.addEventListener("afterprint", () => window.setTimeout(() => removeFrame(frame), 1000))
    } catch {
      // no access to the frame's window — the next print or the timeout removes it
    }
    window.setTimeout(() => {
      try {
        frame.contentWindow?.focus()
        frame.contentWindow?.print()
      } catch {
        if (!viaTab(url)) onBlocked?.()
      }
    }, 400)
  }
  frame.src = url
  document.body.appendChild(frame)
  window.setTimeout(() => removeFrame(frame), 10 * 60_000)
}

function removeFrame(frame: HTMLIFrameElement) {
  if (!frame.isConnected) return
  frame.remove()
  if (frame.dataset.blobUrl) URL.revokeObjectURL(frame.dataset.blobUrl)
}

function viaTab(url: string): boolean {
  const w = window.open(url, "_blank")
  if (!w) return false
  window.setTimeout(() => {
    try {
      w.focus()
      w.print()
    } catch {
      // the tab was closed — the user can still print from it
    }
  }, 1500)
  return true
}
