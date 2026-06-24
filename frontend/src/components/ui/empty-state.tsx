"use client"

import * as React from "react"
import Link from "next/link"
import { Button } from "./button"

// Tier 12 UX: a single EmptyState component
// that handles every "nothing here" case
// across the app. Replaces the ad-hoc
// <div>Keine Daten</div> patterns.
//
// We inline the SVG icons (no lucide-react
// dep — the project doesn't use it
// elsewhere). Each icon is a 24x24 viewBox
// outline glyph at 48x48. The 5px stroke
// matches the rest of the icon set.
//
// `variant` picks the icon + color. Pass
// `inbox` for mail-style empty lists,
// `search` for empty search results,
// `error` for failure states that aren't
// really "empty" but the user has no data
// to look at.

export type EmptyVariant = "default" | "inbox" | "search" | "error" | "offline"

interface EmptyStateProps {
  title: string
  description?: string
  variant?: EmptyVariant
  ctaLabel?: string
  ctaHref?: string
  fullWidth?: boolean
}

const colorMap: Record<EmptyVariant, string> = {
  default: "text-gray-400 dark:text-gray-500",
  inbox: "text-gray-400 dark:text-gray-500",
  search: "text-gray-400 dark:text-gray-500",
  error: "text-red-400 dark:text-red-500",
  offline: "text-amber-400 dark:text-amber-500",
}

function Glyph({ variant }: { variant: EmptyVariant }) {
  // Outline paths for each variant.
  // Inlined rather than a dep so the bundle
  // stays slim. Each is 24x24 viewBox at
  // 1.5px stroke.
  const cls = `h-12 w-12 ${colorMap[variant]}`
  if (variant === "inbox") {
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.564 2.564 0 0 0-.1.661Z" />
      </svg>
    )
  }
  if (variant === "search") {
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
      </svg>
    )
  }
  if (variant === "error") {
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
      </svg>
    )
  }
  if (variant === "offline") {
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.652a3.75 3.75 0 0 1 0-5.304m5.304 0a3.75 3.75 0 0 1 0 5.304m-7.425 2.121a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.807-3.808-9.98 0-13.788m13.788 0c3.808 3.807 3.808 9.98 0 13.788M12 12h.008v.007H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
      </svg>
    )
  }
  // default — file-with-X
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
    </svg>
  )
}

export function EmptyState({
  title,
  description,
  variant = "default",
  ctaLabel,
  ctaHref,
  fullWidth = false,
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center py-12 px-4 ${
        fullWidth ? "w-full" : "max-w-md mx-auto"
      }`}
    >
      <Glyph variant={variant} />
      <h3 className="text-base font-medium text-gray-900 dark:text-gray-100 mt-3">
        {title}
      </h3>
      {description && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-sm">
          {description}
        </p>
      )}
      {ctaLabel && ctaHref && (
        <Link href={ctaHref} className="mt-4">
          <Button>{ctaLabel}</Button>
        </Link>
      )}
    </div>
  )
}