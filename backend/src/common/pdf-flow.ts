/**
 * Tier 644 — a line written without a position starts at the left margin.
 *
 * pdfkit keeps a text cursor. After a table row its x is where the row's last
 * cell begins — the amount column, far right — and `doc.text('3. Abziehbare
 * Vorsteuer')`, written without a position because it "comes next", is set
 * there, as wide as what is left of the page: 90 points. The tax previews
 * (UStVA, UStJA, GewSt, KSt 1, the annexes, Bilanz, G+V) had their section
 * headings broken mid-word in the right-hand column ("Steuer als L /
 * eistungsem / pfänger"), their one-line summary as a column of fragments,
 * and their closing note running off the page — cut, not wrapped, where the
 * call gave a width of its own.
 *
 * With this, a `text()` without x / y that follows a positioned cell (an x of
 * its own, right of the margin, and a width) starts at the left margin again
 * and may use the page's width. A positioned call is left alone, and so is
 * text that continues the line before it.
 */
type Doc = PDFKit.PDFDocument

/**
 * The built-in PDF fonts know the WinAnsi characters and no others. Anything
 * else is written as its two UTF-16 bytes, each read as a character: "↳"
 * came out as "!³", "✓" as "'", the minus sign "−" as a quotation mark —
 * "Aktiva " sonstige Passiva " Jahresüberschuss" in the balance sheet. The
 * signs the texts use, in characters the fonts have.
 */
const PRINTABLE: Array<[RegExp, string]> = [
  [/\u2212/g, '\u2013'],          // − minus → – (en dash)
  [/\u21b3\s?/g, '\u203a '],     // ↳ → ›
  [/\u2713\s?|\u2714\s?/g, ''], // ✓ — the sentence says it
  [/\u2717|\u2718|\u26a0\ufe0f?/g, 'Achtung:'], // ✗ ⚠
  [/\u2192/g, '->'],              // →
  [/\u2265/g, '>='],              // ≥
  [/\u2264/g, '<='],              // ≤
  [/\u2260/g, 'ungleich'],        // ≠
  [/\u03a3/g, 'Summe'],           // Σ
  [/\u0394/g, 'Abw.'],            // Δ
  [/[\u2009\u202f]/g, ' '],      // thin spaces
  // a zero has no sign: rounding a small negative gave "-0,00"
  [/(^|[\s(|:])[-\u2013]\s?0,00(?=$|[\s)|€])/g, '$10,00'],
]

export function printable(text: string): string {
  let out = text
  for (const [from, to] of PRINTABLE) out = out.replace(from, to)
  return out
}

/** Every `text()` of the document in characters its font can print. */
export function printableText<T extends Doc>(doc: T): T {
  const original = doc.text.bind(doc) as (...args: any[]) => Doc
  ;(doc as any).text = (str: any, ...rest: any[]) => original(typeof str === 'string' ? printable(str) : str, ...rest)
  return doc
}

export function flowFromLeft<T extends Doc>(doc: T): T {
  printableText(doc)
  const original = doc.text.bind(doc) as (...args: any[]) => Doc
  let afterCell = false
  let continued = false
  // The cells of a table row are written at one y; the cursor ends below the
  // last of them, which is one line high — a label wrapped to two lines in an
  // earlier cell was overprinted by the next row. The row ends below its
  // tallest cell.
  let row: { y: number; page: unknown; bottom: number } | null = null
  ;(doc as any).text = (str: any, a?: any, b?: any, c?: any) => {
    const positioned = typeof a === 'number'
    const options = ((positioned ? c : a) ?? {}) as PDFKit.Mixins.TextOptions
    if (!positioned && afterCell && !continued) {
      doc.x = doc.page.margins.left
    }
    afterCell = positioned && options.width !== undefined && (a as number) > doc.page.margins.left + 0.5
    continued = !!options.continued
    const result = original(str, a, b, c)
    if (positioned && typeof b === 'number' && options.width !== undefined && !continued) {
      if (row && row.page === doc.page && Math.abs(row.y - b) < 0.01) {
        row.bottom = Math.max(row.bottom, doc.y)
        doc.y = row.bottom
      } else {
        row = { y: b, page: doc.page, bottom: doc.y }
      }
    } else {
      row = null
    }
    return result
  }
  return doc
}
