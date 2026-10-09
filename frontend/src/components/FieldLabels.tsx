"use client"

// Tier 637: about 400 of the app's labels stand in front of their field and
// are not its label — `<label>Firmenname</label><Input />`, no `htmlFor`, no
// `id`. A screen reader announces such a field as "edit text", and a click on
// the word does not put the cursor into the field.
//
// One rule instead of 400 ids: a label that names no field (`for`) and wraps
// none belongs to the next field after it in the same container — the first
// one, among its following siblings up to the next label, that has no name
// of its own. That field gets an id if it has none, and the label points to
// it. A field that carries `aria-label`, `aria-labelledby`, a wrapping label
// or a label with `for` is left alone, so the source wins wherever it says
// something.

import { useEffect } from "react"

const FIELDS = 'input:not([type="hidden"]), select, textarea'

function named(field: Element): boolean {
  return (
    field.hasAttribute("aria-label") ||
    field.hasAttribute("aria-labelledby") ||
    !!field.closest("label") ||
    (!!field.id && !!document.querySelector(`label[for="${CSS.escape(field.id)}"]`))
  )
}

let serial = 0

export function associateLabels(root: Document | Element = document) {
  for (const label of root.querySelectorAll<HTMLLabelElement>("label:not([for])")) {
    if (label.querySelector(FIELDS)) continue
    let field: Element | undefined
    for (let next = label.nextElementSibling; next && !field; next = next.nextElementSibling) {
      if (next.tagName === "LABEL") break
      const inside = next.matches(FIELDS) ? [next] : Array.from(next.querySelectorAll(FIELDS))
      field = inside.find((f) => !named(f))
    }
    if (!field) continue
    if (!field.id) field.id = `field-${++serial}`
    label.htmlFor = field.id
  }
}

export default function FieldLabels() {
  useEffect(() => {
    let frame = 0
    const run = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => associateLabels())
    }
    run()
    // forms appear later: a tab, a dialog, another line of an invoice
    const observer = new MutationObserver(run)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])
  return null
}
