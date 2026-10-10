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
  // "Summe" at (x, doc.y), then its amount at (x2, doc.y): the cursor has
  // moved a line down in between, and the amount stood a line below its
  // label. A cell that starts to the right of the cell just written, at
  // exactly the y that cell ended on, is in that cell's row.
  let last: { x: number; y: number; width: number; bottom: number; page: unknown } | null = null
  let moved: { from: number; to: number; page: unknown } | null = null
  ;(doc as any).text = (str: any, a?: any, b?: any, c?: any) => {
    const positioned = typeof a === 'number'
    const options = ((positioned ? c : a) ?? {}) as PDFKit.Mixins.TextOptions
    // `continued: true` on a table header's cells — "Kz", "Bezeichnung", then
    // "Betrag (€)" at its own x: pdfkit continues the line and adds the width
    // of what came before to the next cell's x, and the amount column's
    // heading was set to the right of the page (x = 893 on a page 595 wide)
    // in fourteen of the previews. A call with a position of its own starts
    // its own text; the line before it is complete.
    if (positioned && typeof b === 'number' && continued) {
      ;(doc as any)._wrapper = null
      ;(doc as any)._textOptions = null
      continued = false
    }
    if (
      positioned && typeof b === 'number' && last && last.page === doc.page &&
      Math.abs(b - last.bottom) < 0.01 && b > last.y && a >= last.x + last.width - 0.5
    ) {
      b = last.y
    }
    // A row that does not fit on the page any more: pdfkit breaks the page in
    // the middle of the cell that overflows, and the row's other cells, written
    // at the y the caller remembered, land at that height on the new page —
    // "GewStG)" alone at the top and its amount at the bottom of an otherwise
    // empty page. The row moves to the next page as a whole.
    if (positioned && typeof b === 'number') {
      if (moved && moved.page === doc.page && Math.abs(b - moved.from) < 0.01) {
        b = moved.to
      } else {
        moved = null
        // (not while a line is being continued: measuring it would take the
        // text out of the line — the EÜR's labels went missing that way)
        if (typeof str === 'string' && !options.continued && !continued) {
          // The first cell of a row is often its shortest (a number); the
          // row needs room for a label of two lines and a note under it.
          const startsRow = !row || row.page !== doc.page || Math.abs(row.y - b) >= 0.01
          const height = Math.max(doc.heightOfString(str, { ...options }), startsRow ? doc.currentLineHeight(true) * 3 : 0)
          if (b + height > doc.page.height - doc.page.margins.bottom && b > doc.page.margins.top + 1) {
            const from = b
            doc.addPage()
            b = doc.page.margins.top
            moved = { from, to: b, page: doc.page }
          }
        }
      }
    } else {
      moved = null
    }
    if (!positioned && afterCell && !continued) {
      doc.x = doc.page.margins.left
    }
    afterCell = positioned && options.width !== undefined && (a as number) > doc.page.margins.left + 0.5
    continued = !!options.continued
    // A cell marked `continued` leaves the cursor on its line; how far down
    // it reaches is measured before it is written (while no line is open).
    const reach = positioned && typeof b === 'number' && options.continued && typeof str === 'string'
      ? b + doc.heightOfString(str, { ...options, continued: false })
      : null
    const result = original(str, a, b, c)
    if (positioned && typeof b === 'number') {
      const cellBottom = reach ?? doc.y
      if (row && row.page === doc.page && Math.abs(row.y - b) < 0.01) {
        row.bottom = Math.max(row.bottom, cellBottom)
        if (reach === null) doc.y = row.bottom
      } else {
        row = { y: b, page: doc.page, bottom: cellBottom }
      }
      last = options.width !== undefined
        ? { x: a as number, y: b, width: options.width, bottom: cellBottom, page: doc.page }
        : null
    } else {
      row = null
      last = null
    }
    return result
  }
  return doc
}
