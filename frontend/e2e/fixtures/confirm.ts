import { expect, type Page } from "@playwright/test"

/**
 * Tier 827 — the app asks with a dialog of its own (components/ConfirmDialog)
 * instead of the browser's `confirm()`; `page.on("dialog")` no longer sees it.
 *
 * acceptConfirms(page, messages?): from now on every confirmation is answered
 * „OK" — what `page.on("dialog", d => d.accept())` did — and its text pushed to
 * `messages`. It answers inside the page (an observer that clicks „OK" when
 * the dialog appears), so a spec that clicks and then waits for a request is
 * not left with the dialog open. For this document and the ones after it.
 *
 * answerConfirm(page, ok): waits for the next one, answers it, returns its text.
 */
const watcher = () => {
  const w = window as unknown as { __confirmWatch?: boolean; __confirmSeen?: (m: string) => void }
  if (w.__confirmWatch) return
  w.__confirmWatch = true
  const check = () => {
    const ok = document.querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-ok"]')
    if (!ok || ok.dataset.answered) return
    ok.dataset.answered = "1"
    const text = document.querySelector('[data-testid="confirm-dialog-message"]')?.textContent || ""
    void w.__confirmSeen?.(text)
    setTimeout(() => ok.click(), 0)
  }
  new MutationObserver(check).observe(document, { childList: true, subtree: true })
  check()
}

// one binding per page; a later call only changes where the texts go
const sinks = new WeakMap<Page, { messages?: string[] }>()

export async function acceptConfirms(page: Page, messages?: string[]): Promise<void> {
  const known = sinks.get(page)
  if (known) {
    known.messages = messages
    return
  }
  const sink: { messages?: string[] } = { messages }
  sinks.set(page, sink)
  await page.exposeFunction("__confirmSeen", (m: string) => { sink.messages?.push(m) })
  await page.addInitScript(watcher)
  await page.evaluate(watcher).catch(() => undefined) // a page already open (or none yet)
}

export async function answerConfirm(page: Page, ok: boolean, timeout = 30_000): Promise<string> {
  const dialog = page.getByTestId("confirm-dialog")
  await expect(dialog).toBeVisible({ timeout })
  const text = (await page.getByTestId("confirm-dialog-message").textContent()) || ""
  await page.getByTestId(ok ? "confirm-dialog-ok" : "confirm-dialog-cancel").click()
  await expect(dialog).toHaveCount(0)
  return text
}
