"use client"

import { useErrorCapture } from "./useErrorCapture"

/**
 * Mount-once error capture. Renders nothing —
 * the hook installs window.onerror +
 * unhandledrejection listeners when the
 * component mounts. Wrap the app in
 * <GlobalErrorCapture> once (in root layout)
 * to catch every unhandled frontend error.
 */
export function GlobalErrorCapture({ children }: { children: React.ReactNode }) {
  useErrorCapture()
  return <>{children}</>
}
