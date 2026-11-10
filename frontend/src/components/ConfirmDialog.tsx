"use client"

/**
 * Tier 827 — the app's own confirmation, in place of the browser's
 * `window.confirm()`.
 *
 * The browser's dialog offered „Diese Seite daran hindern, weitere
 * Dialogfelder zu erstellen": once ticked, every later `confirm()` answered
 * false at once — „Löschen", „Stornieren", „Bestätigen" did nothing, with no
 * word why. It also named the host („localhost:3121 meldet") and ignored the
 * page's language and dark mode.
 *
 * `await askConfirm(message)` — true for „OK", false for „Abbrechen", Escape
 * or a click beside the box. `await askText(message, value)` — in place of
 * `window.prompt()`: the text entered, or null. Rendered into a node of its
 * own, so they can be called from any handler without a provider. A
 * message's line breaks are kept.
 */
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { L } from "@/components/useI18n"

function ConfirmBox({ message, input, onDone }: { message: string; input?: string; onDone: (ok: boolean, value: string) => void }) {
  const okRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(input ?? "")
  useEffect(() => {
    if (input !== undefined) inputRef.current?.select()
    else okRef.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onDone(false, "")
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [onDone, input])
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false, "") }}
      data-testid="confirm-dialog-backdrop"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-describedby="confirm-dialog-message"
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800"
        data-testid="confirm-dialog"
      >
        <p id="confirm-dialog-message" className="whitespace-pre-line text-sm text-gray-800 dark:text-gray-100" data-testid="confirm-dialog-message">
          {message}
        </p>
        {input !== undefined && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onDone(true, value) } }}
            aria-label={message}
            className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            data-testid="confirm-dialog-input"
          />
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onDone(false, "")}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700"
            data-testid="confirm-dialog-cancel"
          >
            {L("Abbrechen")}
          </button>
          <button
            ref={okRef}
            type="button"
            onClick={() => onDone(true, value)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
            data-testid="confirm-dialog-ok"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

function open(message: string, input: string | undefined): Promise<{ ok: boolean; value: string }> {
  if (typeof document === "undefined") return Promise.resolve({ ok: false, value: "" })
  return new Promise((resolve) => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    const before = document.activeElement as HTMLElement | null
    let settled = false
    const done = (ok: boolean, value: string) => {
      if (settled) return
      settled = true
      // after this event, not inside React's own handling of it
      setTimeout(() => {
        root.unmount()
        host.remove()
        before?.focus?.()
      }, 0)
      resolve({ ok, value })
    }
    root.render(<ConfirmBox message={message} input={input} onDone={done} />)
  })
}

export async function askConfirm(message: string): Promise<boolean> {
  return (await open(message, undefined)).ok
}

/** In place of `window.prompt()`: the text entered, or null for „Abbrechen". */
export async function askText(message: string, value = ""): Promise<string | null> {
  const r = await open(message, value)
  return r.ok ? r.value : null
}
