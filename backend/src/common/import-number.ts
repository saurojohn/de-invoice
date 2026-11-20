/**
 * Tier 882 — an amount or a VAT rate from an import cell, read as a German
 * spreadsheet writes it.
 *
 * The imports turned the first comma into a point and handed the rest to
 * `parseFloat`. Measured on the production image: a rent of „1.500,00“
 * became 1,50 € net (0,29 € input VAT), a machine at „1.234,56“ cost
 * 1,23 €. German Excel writes exactly that when it saves a CSV — and the
 * templates the pages offer say „19.99“, which Excel shows as a date or
 * saves back as „19,99“.
 *
 * Read:
 *  - „1.234,56“ / „1234,56“ / „19,99“ — the comma is the decimal mark;
 *  - „1,234.56“ / „1234.56“ / „19.99“ — the point is (English, and the templates);
 *  - „1.234.567“ / „1,234,567“ — groups of three, no decimals;
 *  - „€“, „EUR“ and spaces around are dropped.
 * A single point followed by exactly three digits („1.500“) may be 1 500
 * or 1,5 — it is not guessed; the row is reported. Nothing else is guessed
 * either: what does not read as a number is reported.
 */
export type ImportNumber = { value: number | null } | { error: string }

export function parseImportAmount(v: unknown): ImportNumber {
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : { error: 'keine Zahl' }
  if (v === undefined || v === null) return { value: null }
  let t = String(v).replace(/€|eur/gi, '').replace(/[\s\u00a0]/g, '')
  if (t === '') return { value: null }
  const neg = /^-/.test(t) || /^\(.*\)$/.test(t)
  t = t.replace(/^[-+]/, '').replace(/^\((.*)\)$/, '$1')
  const lastComma = t.lastIndexOf(',')
  const lastPoint = t.lastIndexOf('.')
  let normal: string
  if (lastComma >= 0 && lastPoint >= 0) {
    // both: the later one is the decimal mark, the other groups thousands
    const [group, dec] = lastComma > lastPoint ? [/\./g, ','] : [/,/g, '.']
    const [int, frac] = [t.slice(0, Math.max(lastComma, lastPoint)), t.slice(Math.max(lastComma, lastPoint) + 1)]
    if (!/^\d{1,3}([.,]\d{3})*$/.test(int) || int.includes(dec)) return { error: `„${String(v).slice(0, 30)}“ ist keine Zahl` }
    normal = `${int.replace(group, '')}.${frac}`
  } else if (lastComma >= 0 || lastPoint >= 0) {
    const mark = lastComma >= 0 ? ',' : '.'
    const parts = t.split(mark)
    if (parts.length > 2) {
      // several: groups of three („1.234.567“)
      if (!/^\d{1,3}$/.test(parts[0]) || !parts.slice(1).every((p) => /^\d{3}$/.test(p))) return { error: `„${String(v).slice(0, 30)}“ ist keine Zahl` }
      normal = parts.join('')
    } else {
      const [int, frac] = parts
      if (mark === '.' && /^[1-9]\d{0,2}$/.test(int) && /^\d{3}$/.test(frac)) {
        return { error: `„${String(v).slice(0, 30)}“ ist mehrdeutig (${int}${frac} oder ${int},${frac.replace(/0+$/, '') || '0'}?) — bitte ohne Tausenderpunkt oder mit Komma schreiben` }
      }
      normal = `${int || '0'}.${frac}`
    }
  } else {
    normal = t
  }
  if (!/^\d+(\.\d+)?$/.test(normal)) return { error: `„${String(v).slice(0, 30)}“ ist keine Zahl` }
  const n = Number(normal)
  return { value: neg ? -n : n }
}

/**
 * A VAT rate: „0,19“ / „0.19“ / „19“ / „19 %“ / „7%“ → 0.19 / 0.07.
 * Above 1 it is read as percent. Empty → `fallback`.
 */
export function parseImportRate(v: unknown, fallback: number): ImportNumber {
  if (v === undefined || v === null || String(v).trim() === '') return { value: fallback }
  const pct = /%/.test(String(v))
  const r = parseImportAmount(String(v).replace(/%/g, ''))
  if ('error' in r) return { error: `Steuersatz ${r.error}` }
  if (r.value === null) return { value: fallback }
  const rate = pct || r.value >= 1 ? r.value / 100 : r.value
  if (rate < 0 || rate > 0.3) return { error: `Steuersatz „${String(v).slice(0, 20)}“ ist kein Umsatzsteuersatz` }
  return { value: Math.round(rate * 10000) / 10000 }
}
