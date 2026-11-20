/**
 * Tier 888 — a number typed into a text field, as people type it on a German
 * screen.
 *
 * The forms turned the first comma into a point and handed the rest to
 * `parseFloat` / `Number`. „1.500,00“ became „1.500.00“: `parseFloat` read
 * 1.5 — a payout of 1 500 € from a customer's credit was booked as 1,50 € —
 * and `Number` read NaN (a budget month „1.200,00“ became 0). Two other
 * fields stripped every point first, so „19.99“ became 1999.
 *
 * `amount` (thousands allowed): „1.234,56“, „1234,56“, „1,234.56“, „1234.56“,
 * „1.500“ (= 1 500 — a point before exactly three digits groups thousands on
 * a German screen), „€“ and spaces dropped.
 * `{ thousands: false }` for rates, quantities with decimals and the like:
 * a single „,“ or „.“ is the decimal mark („1.085“ = 1.085).
 *
 * null for an empty field, NaN for what is not a number.
 */
export function parseDecimal(raw: string | null | undefined, opts: { thousands?: boolean } = {}): number | null {
  const thousands = opts.thousands !== false
  let t = String(raw ?? "").replace(/€|eur/gi, "").replace(/[\s\u00a0]/g, "")
  if (t === "") return null
  const neg = t.startsWith("-")
  t = t.replace(/^[-+]/, "")
  const lastComma = t.lastIndexOf(",")
  const lastPoint = t.lastIndexOf(".")
  let normal: string
  if (lastComma >= 0 && lastPoint >= 0) {
    if (!thousands) return NaN
    const decAt = Math.max(lastComma, lastPoint)
    const dec = t[decAt]
    const int = t.slice(0, decAt)
    if (int.includes(dec) || !/^\d{1,3}([.,]\d{3})*$/.test(int)) return NaN
    normal = `${int.replace(/[.,]/g, "")}.${t.slice(decAt + 1)}`
  } else if (lastComma >= 0 || lastPoint >= 0) {
    const mark = lastComma >= 0 ? "," : "."
    const parts = t.split(mark)
    if (parts.length > 2) {
      if (!thousands || !/^\d{1,3}$/.test(parts[0]) || !parts.slice(1).every((p) => /^\d{3}$/.test(p))) return NaN
      normal = parts.join("")
    } else if (thousands && mark === "." && /^[1-9]\d{0,2}$/.test(parts[0]) && /^\d{3}$/.test(parts[1])) {
      normal = parts.join("") // „1.500“ on a German screen
    } else {
      normal = `${parts[0] || "0"}.${parts[1]}`
    }
  } else {
    normal = t
  }
  if (!/^\d+(\.\d+)?$/.test(normal)) return NaN
  const n = Number(normal)
  return neg ? -n : n
}
