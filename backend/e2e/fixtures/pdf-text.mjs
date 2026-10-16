// The text of a PDF, for the specs: node pdf-text.mjs FILE [--lines | --json]
//
// Tier 693: the invoice PDF embeds its fonts (PDF/A-3). PDFKit writes an
// embedded TrueType font as glyph numbers with a ToUnicode table, so the
// specs' old reader — the hex strings of the page decoded as Latin-1 — no
// longer reads the invoice. pdf.js reads both.
//
// Default: all text runs of all pages joined, a space where a line ends (the
// old reader had the space PDFKit writes there), for substring checks.
// --lines: one text run per line. --json: [[run, …] per page].
import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const [file, mode] = process.argv.slice(2)
if (!file) {
  console.error('usage: node pdf-text.mjs FILE [--lines]')
  process.exit(2)
}
let data
try {
  data = new Uint8Array(readFileSync(file))
} catch {
  process.exit(2)
}
try {
  const pdf = await getDocument({ data, verbosity: 0, isEvalSupported: false }).promise
  const pages = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()
    const runs = []
    for (const item of content.items) {
      if (!('str' in item)) continue
      // pdf.js drops the space a wrapped line ends with: put one where a line ends
      if (item.str !== '') runs.push(item.str)
      if (item.hasEOL && runs.length && !/\s$/.test(runs[runs.length - 1])) runs[runs.length - 1] += ' '
    }
    pages.push(runs)
  }
  const all = pages.flat()
  if (mode === '--json') process.stdout.write(JSON.stringify(pages.map((r) => r.map((x) => x.trim()).filter(Boolean))) + '\n')
  else if (mode === '--lines') process.stdout.write(all.map((r) => r.trimEnd()).join('\n') + '\n')
  else process.stdout.write(all.join('') + '\n')
} catch {
  // not a PDF, or a broken one: no text
  process.exit(1)
}
