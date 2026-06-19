"use client"

/**
 * Lightweight toast/snackbar system.
 *
 * Why not sonner / react-hot-toast / notistack?
 *   - 6+ dependencies, ~30-60 KB minified each
 *   - All of them require a Provider mounted at the
 *     app root + a Portal in <body>
 *   - We have one global usage pattern (success on
 *     save, error on failed API call) and don't need
 *     transitions, pause-on-hover, or queueing
 *   - The whole thing fits in ~120 lines of TSX
 *
 * Usage:
 *   import { useToast } from "@/components/useToast"
 *   const toast = useToast()
 *   toast.success("Rechnung gespeichert")
 *   toast.error("Fehler beim Speichern")
 *
 * Mounted via <ToastProvider> in the root layout.
 * Toasts auto-dismiss after `duration` ms (default 4 s).
 * Error toasts stay 6 s by default — users need more
 * time to read the message.
 *
 * Each toast is keyed to the current locale, so
 * translating a message key via useI18n + useToast
 * works as expected:
 *   toast.success(t("customer.saved"))
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react"

export type ToastKind = "success" | "error" | "info" | "warn"

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  duration: number
}

interface ToastApi {
  show: (message: string, opts?: { kind?: ToastKind; duration?: number }) => void
  success: (message: string, duration?: number) => void
  error: (message: string, duration?: number) => void
  info: (message: string, duration?: number) => void
  warn: (message: string, duration?: number) => void
  dismiss: (id: number) => void
}

const ToastCtx = createContext<ToastApi | null>(null)

let _id = 0
const nextId = () => ++_id

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const show = useCallback<ToastApi["show"]>(
    (message, opts = {}) => {
      const kind: ToastKind = opts.kind ?? "info"
      const duration = opts.duration ?? (kind === "error" ? 6000 : 4000)
      const id = nextId()
      setToasts((prev) => [...prev, { id, kind, message, duration }])
    },
    [],
  )

  const success = useCallback<ToastApi["success"]>(
    (message, duration) => show(message, { kind: "success", duration }),
    [show],
  )
  const error = useCallback<ToastApi["error"]>(
    (message, duration) => show(message, { kind: "error", duration }),
    [show],
  )
  const info = useCallback<ToastApi["info"]>(
    (message, duration) => show(message, { kind: "info", duration }),
    [show],
  )
  const warn = useCallback<ToastApi["warn"]>(
    (message, duration) => show(message, { kind: "warn", duration }),
    [show],
  )

  return (
    <ToastCtx.Provider value={{ show, success, error, info, warn, dismiss }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx)
  if (!ctx) {
    // Allow being called outside a provider (e.g. in
    // tests) by falling back to a no-op implementation
    // that logs to console — much friendlier than a hard
    // crash on a missing provider, and the type stays
    // identical so call sites don't need to gate.
    if (typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(
        "useToast() called without <ToastProvider>. " +
          "Wrap your app in <ToastProvider> to see toasts.",
      )
    }
    return {
      show: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
      dismiss: () => {},
    }
  }
  return ctx
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] sm:w-96 pointer-events-none"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

const KIND_STYLES: Record<ToastKind, string> = {
  success:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-900/40 dark:border-emerald-700 dark:text-emerald-100",
  error:
    "border-red-300 bg-red-50 text-red-900 dark:bg-red-900/40 dark:border-red-700 dark:text-red-100",
  warn:
    "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-900/40 dark:border-amber-700 dark:text-amber-100",
  info: "border-blue-300 bg-blue-50 text-blue-900 dark:bg-blue-900/40 dark:border-blue-700 dark:text-blue-100",
}

const KIND_ICONS: Record<ToastKind, string> = {
  success: "✓",
  error: "✕",
  warn: "!",
  info: "i",
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setLeaving(true), toast.duration)
    return () => clearTimeout(t)
  }, [toast.duration])

  useEffect(() => {
    if (!leaving) return
    // Allow the leave animation to play before unmount.
    const t = setTimeout(() => onDismiss(toast.id), 200)
    return () => clearTimeout(t)
  }, [leaving, onDismiss, toast.id])

  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className={
        "pointer-events-auto border rounded-lg shadow-lg px-3 py-2 text-sm flex items-start gap-2 " +
        KIND_STYLES[toast.kind] +
        (leaving ? " opacity-0 translate-x-2 transition-all duration-200" : " opacity-100 translate-x-0 transition-all duration-200")
      }
    >
      <span
        aria-hidden
        className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold shrink-0 mt-0.5 bg-white/60 dark:bg-black/30"
      >
        {KIND_ICONS[toast.kind]}
      </span>
      <p className="flex-1 leading-snug break-words">{toast.message}</p>
      <button
        onClick={() => setLeaving(true)}
        aria-label="Schließen"
        className="text-current/60 hover:text-current shrink-0"
      >
        ×
      </button>
    </div>
  )
}
