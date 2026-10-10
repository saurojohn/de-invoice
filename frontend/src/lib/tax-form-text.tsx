"use client"
/**
 * Tier 657 — the tax previews in the language of the interface.
 *
 * The backend writes the forms in German: 178 line labels, 95 notes on lines,
 * 17 closing notes. On the accounting page in Chinese that was 1 160 of the
 * page's 1 230 German words. The labels are the official designations of
 * German forms and stay — with what they mean underneath; the notes and the
 * closing texts are shown in the language of the interface.
 *
 * The dictionaries (messages/tax-forms/{en,zh}.json) are keyed by the German
 * text with every number replaced by "#" — a year, an amount or a rate in the
 * text does not make it another text — and a translation refers to the n-th
 * number of the German text as {n}. A text without an entry is shown as it
 * came. backend/e2e/389 fails when a preview returns a text that has none.
 */
import { useSyncExternalStore } from "react"

type Dict = Record<string, string>
const NUM = /\d+(?:[.,]\d+)*/g

export const maskKey = (text: string): string => text.trim().replace(NUM, "#")

export function translateFormText(text: string | null | undefined, dict: Dict | null): string | null {
  if (!dict || !text) return null
  const template = dict[maskKey(text)]
  if (!template) return null
  const numbers = text.match(NUM) || []
  return template.replace(/\{(\d+)\}/g, (_m, n: string) => numbers[Number(n) - 1] ?? "")
}

// One dictionary for the page: the language is fixed for a page load
// (switching it reloads), and German needs none.
let dict: Dict | null = null
let started = false
const listeners = new Set<() => void>()

function start() {
  if (started || typeof window === "undefined") return
  started = true
  let locale = "de"
  try { locale = localStorage.getItem("locale") || "de" } catch { /* private mode */ }
  if (locale !== "en" && locale !== "zh") return
  const load = locale === "en" ? import("../../messages/tax-forms/en.json") : import("../../messages/tax-forms/zh.json")
  load
    .then((m) => {
      dict = ((m as { default?: Dict }).default ?? (m as unknown as Dict))
      listeners.forEach((f) => f())
    })
    .catch(() => { started = false })
}
const subscribe = (f: () => void) => { listeners.add(f); start(); return () => { listeners.delete(f) } }
const snapshot = () => dict
const serverSnapshot = () => null

/** A component that calls this is rendered again when the dictionary has loaded. */
export function useFormTexts(): (text: string | null | undefined) => string {
  const d = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  return (text) => (text ? translateFormText(text, d) ?? text : "")
}

/** For an attribute (a tooltip) inside a component that is rendered again by its parent. */
export const formTextNow = (text: string | null | undefined): string => (text ? translateFormText(text, dict) ?? text : "")

/** A line's official German label, and what it means in the language of the interface. */
export function FormLabel({ text }: { text: string | null | undefined }) {
  const d = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const meaning = translateFormText(text, d)
  return (
    <>
      {text}
      {meaning && (
        <span className="block text-[11px] leading-snug text-gray-500 dark:text-gray-400" data-form-gloss lang={undefined}>
          {meaning}
        </span>
      )}
    </>
  )
}

/** A note or a closing text: in the language of the interface, else as it came. */
export function FormNote({ text }: { text: string | null | undefined }) {
  const tf = useFormTexts()
  return <>{tf(text)}</>
}
