"use client"

import { useEffect, useState, type KeyboardEvent } from "react"

// A search field with its matches listed underneath is a combobox, and it
// was one for the mouse only: the arrow keys did nothing, Enter sent the
// form, Tab left the field and the list closed behind it. Whoever fills in
// an invoice without a mouse could type a customer's name and never choose
// the customer.
//
// One instance serves every such field of a page — only one list is open at
// a time. The field gets `input(...)`, each entry `option(...)`:
//   ↓ / ↑   move the mark through the list, round the ends
//   Enter   takes the marked entry (and does not send the form)
//   Escape  closes the list
// Without a marked entry Enter does what it did before.
export function usePicker() {
  const [at, setAt] = useState<{ list: string; index: number } | null>(null)

  useEffect(() => {
    if (at) document.getElementById(`${at.list}-${at.index}`)?.scrollIntoView({ block: "nearest" })
  }, [at])

  const indexIn = (list: string) => (at && at.list === list ? at.index : -1)

  return {
    /** The text was changed: the list is another one, nothing in it is marked. */
    reset: () => setAt(null),

    input(list: string, open: boolean, count: number, choose: (index: number) => void, close: () => void) {
      const index = open ? Math.min(indexIn(list), count - 1) : -1
      return {
        role: "combobox" as const,
        "aria-autocomplete": "list" as const,
        "aria-expanded": open,
        "aria-controls": list,
        "aria-activedescendant": index >= 0 ? `${list}-${index}` : undefined,
        onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
          // Enter that ends an input method's composition is not a choice.
          if (!open || e.nativeEvent.isComposing) return
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (count === 0) return
            e.preventDefault()
            const step = e.key === "ArrowDown" ? 1 : -1
            setAt({ list, index: index < 0 ? (step > 0 ? 0 : count - 1) : (index + step + count) % count })
          } else if (e.key === "Enter" && index >= 0) {
            e.preventDefault()
            setAt(null)
            choose(index)
          } else if (e.key === "Escape") {
            setAt(null)
            close()
          }
        },
      }
    },

    option(list: string, index: number) {
      return { id: `${list}-${index}`, role: "option" as const, "aria-selected": indexIn(list) === index }
    },
  }
}

/** The mark of the entry the arrow keys are on. */
export const PICKED = "aria-selected:bg-blue-100 dark:aria-selected:bg-blue-900/40"
