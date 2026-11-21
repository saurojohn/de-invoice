/**
 * Tiny RFC 4180 CSV parser.
 *
 * Why hand-written instead of pulling in papaparse /
 * csv-parse: this is the only place in the project that
 * parses CSV, and the rules we need are 8 lines.
 * Pulling in a 50KB dep for that would dwarf the rest
 * of the BulkImport feature.
 *
 * Supports:
 *   - Comma, semicolon or tab as the field separator — the one of the
 *     header line (Tier 882: it used to split on both)
 *     (German Excel defaults to ; — when you save as
 *     CSV from Excel in the de-DE locale, the separator
 *     is ;, not ,. We auto-detect by sniffing the
 *     first line.)
 *   - Quoted fields with embedded commas / newlines /
 *     quotes (doubled quote = single quote per RFC)
 *   - Trailing / leading whitespace per field
 *   - CRLF / LF / CR line endings
 *
 * Does NOT support:
 *   - Multi-character separators (rare, not worth it)
 *   - BOM stripping — caller should `.replace(/^\uFEFF/, '')`
 *     before calling if the file may have one (Excel
 *     adds a BOM on UTF-8 save)
 *
 * Returns:
 *   { headers: string[], rows: Record<string, string>[] }
 *   Empty rows (where all fields are empty strings) are
 *   skipped — common when the user leaves trailing
 *   lines in their spreadsheet.
 */
export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
}

/**
 * Parse a CSV string into rows.
 *
 * Auto-detects the separator by counting how often each
 * candidate appears on the header line. The candidate
 * with the higher count wins. Falls back to comma when
 * tied. This handles the German-Excel case
 * (separator=;) and the English-Excel / TSV / hand-
 * edited cases (separator=,) without requiring the
 * user to specify it in a dropdown.
 */
export function parseCsv(text: string): ParsedCsv {
  // Strip BOM — Excel prepends one on UTF-8 save.
  const clean = text.replace(/^\uFEFF/, '')
  // Tier 882: one separator, the one of the header line. Both „,“ and „;“
  // split every row: a German Excel row „Schraube;1234,56“ became three
  // cells and every column after the price moved one to the right.
  const sep = detectSeparator(clean.split(/\r?\n/)[0] || '')

  // Split into rows using a state machine (rather than
  // a regex) because quoted fields can contain \n.
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (inQuotes) {
      if (c === '"') {
        // Doubled quote inside a quoted field = literal
        // quote per RFC 4180. Single quote = end of field.
        if (clean[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else {
      if (c === '"') {
        inQuotes = true
      } else if (c === sep) {
        row.push(field)
        field = ''
      } else if (c === '\n' || c === '\r') {
        // \r\n → skip the \r (handled by the \n branch)
        if (c === '\r' && clean[i + 1] === '\n') continue
        row.push(field)
        field = ''
        rows.push(row)
        row = []
      } else {
        field += c
      }
    }
  }
  // Last field / row (no trailing newline)
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  if (rows.length === 0) {
    return { headers: [], rows: [] }
  }

  const headers = rows[0].map((h) => h.trim())
  const dataRows = rows
    .slice(1)
    // Drop rows where every field is empty (trailing
    // blank lines from the editor)
    .filter((r) => r.some((c) => c && c.trim() !== ''))
    .map((r) => {
      const obj: Record<string, string> = {}
      headers.forEach((h, idx) => {
        obj[h] = (r[idx] ?? '').trim()
      })
      return obj
    })

  return { headers, rows: dataRows }
}

/** Tier 882: the separator of a header line — „;“ (German Excel), tab, or „,“ */
export function detectSeparator(headerLine: string): string {
  const unquoted = headerLine.replace(/"[^"]*"/g, '')
  const count = (c: string) => unquoted.split(c).length - 1
  const counts: [string, number][] = [[';', count(';')], ['\t', count('\t')], [',', count(',')]]
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a))
  return best[1] > 0 ? best[0] : ','
}

/**
 * Tier 882 — the text of a CSV file, in the encoding it was saved in.
 *
 * `file.text()` reads UTF-8 only. German Excel's „CSV (Trennzeichen-
 * getrennt)“ is Windows-1252: „Müller“ arrived as „M\uFFFDller“ and was
 * stored that way. A file that is not valid UTF-8 is read as Windows-1252.
 */
export async function readCsvFile(file: Blob): Promise<string> {
  const bytes = await file.arrayBuffer()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/**
 * Tier 897 — a cell of a CSV file the browser builds (the customer and
 * product lists, the aging report, the statistics, the cost-centre report).
 *
 * Tier 857 kept the files the server writes from carrying a formula; the
 * files built here did not: a customer called „=HYPERLINK("https://…";"…")“
 * became a link — or a calculation — in the list the owner or the
 * Steuerberater opens in Excel (CSV / formula injection, OWASP). Text that
 * begins with = + - @ (or a tab / line break) gets a leading apostrophe, as
 * on the server (backend/src/common/csv.ts); a number stays a number
 * („-12,50“, „+3“). A number is written with a decimal comma (Tier 648).
 * The cell is quoted when it holds a quote, a semicolon or a line break.
 */
export function csvText(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "number" ? String(v).replace(".", ",") : String(v)
  return /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d[\d.,]*$/.test(s) ? `'${s}` : s
}

export function csvCell(v: unknown): string {
  const s = csvText(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
