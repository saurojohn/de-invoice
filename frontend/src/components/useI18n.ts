/**
 * i18n hook — single source of truth: messages/*.json
 *
 * History: this file used to hand-inline all three locale
 * message trees (de/en/zh) in a single big const `messages`
 * object. That worked when only a few keys existed, but every
 * new key added to messages/*.json had to be manually mirrored
 * here too — easy to forget, easy to drift. The create-invoice
 * page was showing the raw key text "invoice.deliveryDate"
 * and "invoice.createAndPrint" because those keys had been
 * added to the JSON files but never to this mirror. The
 * fallback in t() (return value || key) is what made the bug
 * visible: missing keys render as the dotted key string instead
 * of the actual translation.
 *
 * Fix: import the JSON files directly. TypeScript can resolve
 * them at build time (resolveJsonModule is on by default in
 * Next.js + tsconfig), they're already the runtime source of
 * truth, and adding a new key anywhere means updating exactly
 * one file per locale.
 *
 * The hook API ({ t, locale, switchLocale, getDateLocale,
 * mounted }) is unchanged so all 14 dashboard pages keep
 * working without modification.
 */
"use client"

import { useState, useEffect } from "react"

import deMessages from "../../messages/de.json"
import enMessages from "../../messages/en.json"
import zhMessages from "../../messages/zh.json"

// We type the bag loosely here because the three locales are
// not 1:1: e.g. en.json has an "accounting" top-level section
// that de.json and zh.json don't have yet (it's been added
// in EN first). The t() function below is dynamic anyway —
// it walks the tree by dotted key path and returns the raw
// key string if a leaf is missing — so a strict type for the
// bag would only catch the structural mismatch without
// helping with the per-key translations (which are already
// untyped because they live in JSON).
const messages: Record<string, any> = {
  de: deMessages,
  en: enMessages,
  zh: zhMessages,
}

export function useI18n() {
  const [locale, setLocale] = useState("de")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const saved = localStorage.getItem("locale") || "de"
    setLocale(saved)
  }, [])

  // Walk the nested object by dotted-key path. Returns the
  // key string itself if any segment is missing — this is the
  // silent bug we want to surface (raw key text in the UI is
  // a clear sign a translation is missing, much better than
  // empty string or undefined).
  //
  // Optional `vars` performs simple {name} substitution on the
  // resolved string, e.g.
  //   t("auth.attemptsLeft", { count: "3" })
  //   → "Noch 3 verbleibende Versuche"
  // The value is always stringified, so callers can pass
  // numbers without wrapping them. Missing variables stay
  // literal (we never throw on missing interpolation) — that
  // way a translation that didn't reference the variable just
  // shows the original text, which is what translators expect.
  const t = (key: string, vars?: Record<string, string | number>): string => {
    const keys = key.split(".")
    let value: any = messages[locale]
    for (const k of keys) {
      value = value?.[k]
    }
    if (typeof value !== "string") return value || key
    if (!vars) return value
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, "g"), String(v)),
      value,
    )
  }

  const switchLocale = (code: string) => {
    setLocale(code)
    localStorage.setItem("locale", code)
    // Reload so server-rendered bits (date pickers, intl
    // formatters) pick up the new locale on the next render.
    window.location.reload()
  }

  // Maps the in-app language code to a BCP 47 locale tag for
  // use with toLocaleDateString / toLocaleString. Used by
  // every dashboard page that formats a date — keeping the
  // mapping in one place avoids subtle mismatches like
  // "en" → "en-DE" or "zh" → "zh-TW" if someone copies a
  // date formatter from one page to another.
  const getDateLocale = (): string => {
    switch (locale) {
      case "de": return "de-DE"
      case "en": return "en-US"
      case "zh": return "zh-CN"
      default: return "de-DE"
    }
  }

  return { locale, t, switchLocale, getDateLocale, mounted }
}
