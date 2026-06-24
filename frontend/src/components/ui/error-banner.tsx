"use client"

import * as React from "react"

// Tier 12 UX: dismissible error banner.
// Replaces the bare `alert(...)` pattern
// that was scattered across pages.
//
// Use for "the request failed but the
// page is otherwise usable" — e.g. an
// upload that didn't complete. For full-
// page failures (e.g. the main data fetch
// 500'd) use the EmptyState error variant
// instead — that takes the full container
// width and signals "nothing useful here
// yet".
//
// `variant` picks the color treatment:
//   - error (red) — failures
//   - warning (amber) — partial success /
//     needs attention
//   - info (blue) — informational only
//
// The dismiss button calls `onDismiss`
// (parent owns the visibility state). We
// don't auto-dismiss on a timer — the
// user needs to see the error AND act on
// it before it disappears. A 5s timeout
// would feel snappy in dev but is the
// source of the "I clicked submit and
// nothing happened" reports in production.

type Variant = "error" | "warning" | "info"

interface ErrorBannerProps {
  title: string
  message?: string
  variant?: Variant
  onDismiss?: () => void
  // Optional retry handler — the most
  // common follow-up after seeing an
  // error is "try again". Showing the
  // button inline saves a click.
  onRetry?: () => void
  retryLabel?: string
}

const variantClasses: Record<Variant, string> = {
  error:
    "bg-red-50 border-red-200 text-red-800 dark:bg-red-900/30 dark:border-red-800 dark:text-red-200",
  warning:
    "bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-900/30 dark:border-amber-800 dark:text-amber-200",
  info: "bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-900/30 dark:border-blue-800 dark:text-blue-200",
}

function AlertIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
    </svg>
  )
}

function CloseIcon({ className }: { className: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  )
}

export function ErrorBanner({
  title,
  message,
  variant = "error",
  onDismiss,
  onRetry,
  retryLabel = "Wiederholen",
}: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-md border p-3 text-sm ${variantClasses[variant]}`}
    >
      <AlertIcon className="h-5 w-5 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-medium">{title}</div>
        {message && (
          <div className="mt-1 text-xs opacity-90 break-words">
            {message}
          </div>
        )}
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-2 text-xs font-medium underline underline-offset-2 hover:no-underline"
          >
            {retryLabel}
          </button>
        )}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Schließen"
          className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}