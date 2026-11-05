"use client"

/**
 * Tier 804 — a link to "#form-gewst" lands on its form even when the page
 * grows above it afterwards.
 *
 * The browser scrolls to the anchor once, when the page is first laid out;
 * the sections above it then load their data and push the target down, out
 * of view (the dashboard's deadlines open /dashboard/accounting#form-gewst and
 * /dashboard/accounting/ustva#zm). While the page is still growing — for a
 * few seconds — the target is scrolled back into view on every change of the
 * page's height; the first scroll, touch or key of the user's ends it.
 */
import { useEffect } from "react"

const SETTLE_MS = 4000

export function useHashAnchor() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (!id) return
    let done = false
    const place = () => {
      if (done) return
      document.getElementById(id)?.scrollIntoView({ block: "start" })
    }
    const stop = () => {
      done = true
      observer.disconnect()
      clearTimeout(timer)
      for (const ev of USER_EVENTS) window.removeEventListener(ev, stop)
    }
    const observer = new ResizeObserver(place)
    observer.observe(document.body)
    const timer = setTimeout(stop, SETTLE_MS)
    for (const ev of USER_EVENTS) window.addEventListener(ev, stop, { passive: true })
    place()
    return stop
  }, [])
}

const USER_EVENTS = ["wheel", "touchstart", "keydown", "mousedown"] as const
