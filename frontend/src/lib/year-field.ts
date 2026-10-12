import { useEffect, useRef, useState, type ChangeEvent } from "react"

/**
 * A year field that only reports a whole year.
 *
 * The field keeps what is being typed; the caller's year changes when the
 * text is a year between 2000 and 2100, and not before. Without it, typing
 * „2024“ asked the server for the years 2, 20 and 202 and showed „year ist
 * ungültig“ three times (Tier 669 — every form on the accounting page).
 * A year left half-typed goes back to the one that is loaded.
 *
 *   const yearField = useYearField(year, setYear)
 *   <input type="number" min={2000} max={2100} {...yearField} />
 */
export function useYearField(year: number, onYear: (year: number) => void) {
  const [text, setText] = useState(String(year))
  const loaded = useRef(year)
  loaded.current = year
  useEffect(() => {
    setText(String(year))
  }, [year])
  return {
    value: text,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const typed = e.target.value
      setText(typed)
      const n = Number(typed)
      if (/^\d{4}$/.test(typed) && n >= 2000 && n <= 2100 && n !== loaded.current) onYear(n)
    },
    onBlur: () => setText(String(loaded.current)),
  }
}
