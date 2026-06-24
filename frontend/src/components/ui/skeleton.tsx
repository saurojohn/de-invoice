"use client"

import * as React from "react"

// Tier 12 UX: a small set of skeleton
// primitives for the loading state.
//
// We don't pull in shadcn's full skeleton
// package (it brings clsx + cva + a few
// other deps). These are 90% of what we
// actually use — single-line, multi-line,
// card-shaped, table-row. The classes are
// Tailwind-only so they collapse into
// the same CSS layer as the rest of the
// UI.

interface SkeletonProps
  extends React.HTMLAttributes<HTMLDivElement> {}

/**
 * Single-line / single-block placeholder.
 * Pulses with a low-opacity gradient.
 * Use for individual lines of text, a
 * single icon, a button. The default
 * height is `h-4` (16px) which matches
 * body-text — pass `h-6` for headings.
 */
export function Skeleton({ className = "", ...props }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse rounded-md bg-gray-200 dark:bg-gray-700 ${className}`}
      {...props}
    />
  )
}

/**
 * Multi-line text block — N rows of
 * decreasing width, mimicking a paragraph.
 * Use for card content placeholders.
 */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="h-4"
          style={{
            // The last line is shorter so
            // the block doesn't look like a
            // ruler. The other lines are
            // full-width.
            width: i === lines - 1 ? "75%" : "100%",
          }}
        />
      ))}
    </div>
  )
}

/**
 * Card-shaped placeholder for a single
 * KPI tile. Combines a label skeleton
 * + value skeleton + sparkline placeholder.
 */
export function SkeletonCard() {
  return (
    <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg space-y-3">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-3 w-24" />
    </div>
  )
}

/**
 * N rows of table-shaped placeholders.
 * Use for the "loading list" state of
 * any tabular page (invoices, customers,
 * products, etc).
 */
export function SkeletonTable({
  rows = 5,
  cols = 4,
}: {
  rows?: number
  cols?: number
}) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton
              key={c}
              className="h-6 flex-1"
              style={{
                // First column wider, last column narrower —
                // gives the table a recognisable shape
                // while loading.
                maxWidth: c === 0 ? "30%" : c === cols - 1 ? "15%" : "100%",
              }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}